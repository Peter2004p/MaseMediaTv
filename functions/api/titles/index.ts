import { Env, json, requireAdmin } from "../auth/_shared";
type StoredTitle = { id: string; name: string; kind: string; metadata_json: string; created_at: string };
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
      type: String(metadata.type || "").trim().toLowerCase() === "drama" || String(row.kind || "").trim().toLowerCase() === "drama" ? "Drama" : "Movie",
      description: typeof metadata.description === "string" ? metadata.description : "",
      year: String(metadata.year || ""),
      posterUrl: typeof metadata.posterUrl === "string" ? metadata.posterUrl : "",
      quality: String(metadata.quality || episodes[0]?.quality || "720p"),
      episodes,
    };
  });
  // Present duplicate uploads of the same series as one library folder.
  const grouped = new Map<string, Record<string, unknown>>();
  for (const title of titles as Record<string, unknown>[]) {
    const key = String(title.type || "Movie").toLowerCase() + "|" + String(title.name || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const current = grouped.get(key);
    if (!current) { grouped.set(key, title); continue; }
    const all = [...(Array.isArray(current.episodes) ? current.episodes as Record<string, unknown>[] : []), ...(Array.isArray(title.episodes) ? title.episodes as Record<string, unknown>[] : [])];
    const seen = new Map<string, Record<string, unknown>>();
    for (const ep of all) {
      const episodeKey = String(ep.season || 1) + "|" + String(ep.episode || 1) + "|" + String(ep.quality || "");
      if (!seen.has(episodeKey)) seen.set(episodeKey, ep);
    }
    current.episodes = [...seen.values()].sort((a,b) => Number(a.season||1)-Number(b.season||1) || Number(a.episode||1)-Number(b.episode||1));
    // Keep the richer metadata/poster when another duplicate upload has blanks.
    for (const field of ["description","posterUrl","posterPath","year"]) if (!current[field] && title[field]) current[field] = title[field];
    if (!current.id && title.id) current.id = title.id;
  }
  return json({ titles: [...grouped.values()] });
};
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const body = await request.json() as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "A title name is required." }, 400);
  const kind = String(body.type || "").trim().toLowerCase() === "drama" ? "drama" : "movie";
  const normalizedName = body.name.trim().normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const existingRows = await env.DB.prepare("SELECT id,name,kind,metadata_json FROM titles WHERE kind=?").bind(kind).all<{id:string;name:string;kind:string;metadata_json:string}>();
  const existing = (existingRows.results || []).find(row => row.name.trim().normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === normalizedName);
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

  // Best-effort channel notifications must not undo a successful catalog publish.
  const config = env as Env & { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_MINI_APP_URL?: string; TELEGRAM_WEBAPP_URL?: string };
  const token = config.TELEGRAM_BOT_TOKEN;
  const telegramNotifications = { attempted: !!token, delivered: 0, failed: 0 };
  if (token) {
    const appUrl = (config.TELEGRAM_MINI_APP_URL || config.TELEGRAM_WEBAPP_URL || "").trim();
    const year = title.year ? " (" + String(title.year).slice(0, 4) + ")" : "";
    const description = typeof title.description === "string" ? title.description.trim().slice(0, 700) : "";
    const message = "🎬 New on MaseNet: " + String(title.name).trim().slice(0, 180) + year + "\n" +
      (kind === "drama" ? "Drama" : "Movie") +
      (description ? "\n\n" + description : "") +
      (appUrl.startsWith("https://") ? "\n\nOpen MaseNet: " + appUrl : "");
    for (const chatId of ["@MaseMediaTv", "@MoonDramaC"]) {
      try {
        const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: false })
        });
        if (response.ok) telegramNotifications.delivered++;
        else telegramNotifications.failed++;
      } catch { telegramNotifications.failed++; }
    }
  }
  return json({ title, telegramNotifications }, 201);
};
