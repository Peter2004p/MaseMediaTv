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
      type: metadata.type === "Drama" || row.kind === "drama" ? "Drama" : "Movie",
      description: typeof metadata.description === "string" ? metadata.description : "",
      year: String(metadata.year || ""),
      posterUrl: typeof metadata.posterUrl === "string" ? metadata.posterUrl : "",
      quality: String(metadata.quality || episodes[0]?.quality || "720p"),
      episodes,
    };
  });
  return json({ titles });
};
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const body = await request.json() as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "A title name is required." }, 400);
  const id = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
  const title: Record<string, unknown> = { ...body, id };
  const kind = title.type === "Drama" ? "drama" : "movie";
  await env.DB.prepare("INSERT INTO titles (id,name,kind,metadata_json) VALUES (?,?,?,?)").bind(id, title.name, kind, JSON.stringify(title)).run();

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
