import { Env, json, requireAdmin } from "../auth/_shared";
type StoredTitle = { id: string; name: string; kind: string; metadata_json: string; created_at: string };
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rows = await env.DB.prepare("SELECT id,name,kind,metadata_json,created_at FROM titles ORDER BY created_at DESC").all<StoredTitle>();
  const titles = (rows.results || []).map((row) => {
    try { return JSON.parse(row.metadata_json); }
    catch { return { id: row.id, name: row.name, type: row.kind === "drama" ? "Drama" : "Movie", episodes: [] }; }
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
