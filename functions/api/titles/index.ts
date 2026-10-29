import { Env, json, requireAdmin } from "../auth/_shared";
type StoredTitle = { id: string; name: string; kind: string; metadata_json: string; created_at: string };
const normalizeTitleType = (...values: unknown[]): "Movie" | "Drama" => {
  for (const value of values) {
    const type = String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
    if (["drama", "dramas", "series", "tv series", "tv show", "show", "episode"].includes(type)) return "Drama";
    if (["movie", "movies", "film", "films", "feature film"].includes(type)) return "Movie";
  }
  return "Movie";
};
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rows = await env.DB.prepare("SELECT id,name,kind,metadata_json,created_at FROM titles ORDER BY created_at DESC").all<StoredTitle>();
  const titles = (rows.results || []).map((row) => {
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch { /* Fall back to the canonical database columns. */ }
    // The database columns are authoritative for identity. A malformed or older
    // metadata payload must not make a published card impossible to open.
    const episodes = Array.isArray(metadata.episodes)
      ? metadata.episodes.filter((episode): episode is Record<string, unknown> => !!episode && typeof episode === "object" && !Array.isArray(episode)).map((episode, index) => ({
          ...episode,
          id: String(episode.id || row.id + "-episode-" + (index + 1)),
          title: String(episode.title || episode.name || ("Episode " + (index + 1))),
          season: Number(episode.season) || 1,
          episode: Number(episode.episode) || index + 1,
          quality: String(episode.quality || metadata.quality || "720p"),
          streamUrl: typeof episode.streamUrl === "string" ? episode.streamUrl : "",
        }))
      : [];
    return {
      ...metadata,
      id: row.id,
      name: String(metadata.name || row.name || "Untitled"),
      type: normalizeTitleType(metadata.type, row.kind),
      description: typeof metadata.description === "string" ? metadata.description : "",
      year: String(metadata.year || ""),
      posterUrl: typeof metadata.posterUrl === "string" ? metadata.posterUrl : "",
      quality: String(metadata.quality || episodes[0]?.quality || "720p"),
      episodes,
    };
  });
  // Keep movies as individual records. Only drama records are merged into series folders.
  const grouped = new Map<string, Record<string, unknown>>();
  const standaloneMovies: Record<string, unknown>[] = [];
  for (const rawTitle of titles as Record<string, unknown>[]) {
    const title: Record<string, unknown> = { ...rawTitle, type: normalizeTitleType(rawTitle.type) };
    if (title.type !== "Drama") {
      standaloneMovies.push(title);
      continue;
    }
    const normalizedName = String(title.name || "").normalize("NFKC").toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const key = "drama|" + (normalizedName || String(title.id || crypto.randomUUID()));
    const current = grouped.get(key);
    if (!current) { grouped.set(key, title); continue; }
    const all = [...(Array.isArray(current.episodes) ? current.episodes as Record<string, unknown>[] : []), ...(Array.isArray(title.episodes) ? title.episodes as Record<string, unknown>[] : [])];
    const seen = new Map<string, Record<string, unknown>>();
    for (const ep of all) {
      const episodeKey = String(ep.season || 1) + "|" + String(ep.episode || 1) + "|" + String(ep.quality || "");
      if (!seen.has(episodeKey)) seen.set(episodeKey, ep);
    }
    current.episodes = [...seen.values()].sort((a,b) => Number(a.season||1)-Number(b.season||1) || Number(a.episode||1)-Number(b.episode||1));
    for (const field of ["description","posterUrl","posterPath","year"]) if (!current[field] && title[field]) current[field] = title[field];
  }
  return json({ titles: [...standaloneMovies, ...grouped.values()] });
};
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const body = await request.json() as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "A title name is required." }, 400);
  const kind = normalizeTitleType(body.type) === "Drama" ? "drama" : "movie";
  const normalizedName = body.name.trim().normalize("NFKC").toLowerCase().replace(/[’\']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const existingRows = await env.DB.prepare("SELECT id,name,kind,metadata_json FROM titles WHERE kind=?").bind(kind).all<{id:string;name:string;kind:string;metadata_json:string}>();
  const existing = (existingRows.results || []).find(row => row.name.trim().normalize("NFKC").toLowerCase().replace(/[’\']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim() === normalizedName);
  let id: string;
  let title: Record<string, unknown>;
  if (existing) {
    let previous: Record<string, unknown> = {};
    try { previous = JSON.parse(existing.metadata_json) as Record<string, unknown>; } catch {}
    const oldEpisodes = Array.isArray(previous.episodes) ? previous.episodes as Record<string, unknown>[] : [];
    const newEpisodes = Array.isArray(body.episodes) ? body.episodes as Record<string, unknown>[] : [];
    const episodeMap = new Map<string, Record<string, unknown>>();
    for (const episode of [...oldEpisodes, ...newEpisodes]) {
      const key = String(episode.season || 1) + "|" + String(episode.episode || 1) + "|" + String(episode.quality || body.quality || "");
      const prior = episodeMap.get(key);
      episodeMap.set(key, prior ? { ...prior, ...episode, subtitleTracks: episode.subtitleTracks || prior.subtitleTracks, qualities: episode.qualities || prior.qualities } : episode);
    }
    id = existing.id;
    title = {
      ...previous, ...body, id, name: existing.name,
      description: String(body.description || previous.description || ""),
      posterUrl: String(body.posterUrl || previous.posterUrl || ""),
      posterPath: body.posterPath || previous.posterPath,
      year: String(body.year || previous.year || ""),
      episodes: [...episodeMap.values()].sort((a,b) => Number(a.season||1)-Number(b.season||1) || Number(a.episode||1)-Number(b.episode||1)),
    };
    await env.DB.prepare("UPDATE titles SET name=?,kind=?,metadata_json=?,updated_at=datetime('now') WHERE id=?").bind(existing.name, kind, JSON.stringify(title), id).run();
  } else {
    id = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
    title = { ...body, id };
    await env.DB.prepare("INSERT INTO titles (id,name,kind,metadata_json) VALUES (?,?,?,?)").bind(id, String(title.name), kind, JSON.stringify(title)).run();
  }

  // Notify opted-in private chats and explicitly registered channels. Existing episodes
  // are compared by season/episode number so edits do not resend old announcements.
  const config = env as Env & { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_MINI_APP_URL?: string; TELEGRAM_WEBAPP_URL?: string };
  const token = config.TELEGRAM_BOT_TOKEN;
  const telegramNotifications = { attempted: false, delivered: 0, failed: 0 };
  const previousEpisodeKeys = new Set<string>();
  if (existing) {
    let previous: Record<string, unknown> = {};
    try { previous = JSON.parse(existing.metadata_json) as Record<string, unknown>; } catch {}
    for (const ep of (Array.isArray(previous.episodes) ? previous.episodes : []) as Record<string, unknown>[]) {
      previousEpisodeKeys.add(String(ep.season || 1) + "|" + String(ep.episode || 1));
    }
  }
  const allEpisodes = (Array.isArray(title.episodes) ? title.episodes : []) as Record<string, unknown>[];
  const newEpisodes = allEpisodes.filter(ep => !previousEpisodeKeys.has(String(ep.season || 1) + "|" + String(ep.episode || 1)));
  const isNewTitle = !existing;
  if (token && (isNewTitle || newEpisodes.length)) {
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_subscribers (
        chat_id TEXT PRIMARY KEY, chat_type TEXT NOT NULL, title TEXT,
        active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`).run();
      const targets = await env.DB.prepare("SELECT chat_id FROM telegram_subscribers WHERE active=1").all<{chat_id:string}>();
      // Telegram notifications must open the Mini App, not the public website.
      // startapp is passed through Telegram's configured main Mini App for this bot.
      const botUsername = "MaseTv_Bot";
      const appLink = "https://t.me/" + botUsername + "?startapp=" + encodeURIComponent("title_" + String(title.id || id));
      const announcement = isNewTitle
        ? "🎬 NEW " + (kind === "drama" ? "DRAMA" : "MOVIE") + " ON MASETV\n\n" + String(title.name).trim().slice(0,180) + (title.year ? " (" + String(title.year).slice(0,4) + ")" : "") + (typeof title.description === "string" && title.description.trim() ? "\n\n" + title.description.trim().slice(0,500) : "") + "\n\n▶️ Watch in MaseNet on Telegram: " + appLink
        : "🍿 NEW EPISODE\n\n" + String(title.name).trim().slice(0,180) + "\n" + newEpisodes.map(ep => "Season " + String(ep.season || 1) + " · Episode " + String(ep.episode || "?") + (ep.title ? " — " + String(ep.title).slice(0,100) : "")).join("\n") + "\n\n▶️ Open in MaseNet on Telegram: " + appLink;
      telegramNotifications.attempted = true;
      for (const target of targets.results || []) {
        try {
          const poster = typeof title.posterUrl === "string" ? title.posterUrl.trim() : "";
          const canSendPoster = isNewTitle && /^https:\/\//i.test(poster);
          const method = canSendPoster ? "sendPhoto" : "sendMessage";
          const payload: Record<string, unknown> = canSendPoster
            ? { chat_id: target.chat_id, photo: poster, caption: announcement.slice(0,1024) }
            : { chat_id: target.chat_id, text: announcement, disable_web_page_preview: true };
          const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
          });
          const data = await response.json().catch(() => ({})) as {ok?:boolean;description?:string};
          if (response.ok && data.ok) telegramNotifications.delivered++;
          else {
            // If Telegram cannot fetch the poster URL, still deliver the Mini App link as text.
            if (canSendPoster) {
              const fallback = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ chat_id: target.chat_id, text: announcement, disable_web_page_preview: true })
              }).catch(() => null);
              const fallbackData = fallback ? await fallback.json().catch(() => ({})) as {ok?:boolean;description?:string} : {};
              if (fallback?.ok && fallbackData.ok) { telegramNotifications.delivered++; continue; }
            }
            telegramNotifications.failed++;
            if (/blocked by the user|chat not found|bot was kicked|user is deactivated/i.test(String(data.description || ""))) {
              await env.DB.prepare("UPDATE telegram_subscribers SET active=0,updated_at=datetime('now') WHERE chat_id=?").bind(target.chat_id).run();
            }
          }
        } catch { telegramNotifications.failed++; }
      }
    } catch { telegramNotifications.failed++; }
  }
  return json({ title, telegramNotifications }, 201);
};
