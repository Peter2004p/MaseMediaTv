import { json } from "../auth/_shared";
import { loadMediaVaultConfig } from "../admin/_media-vault-config";

interface Env {
  DB: D1Database;
  MASE_STREAM_BOT_WEBHOOK_SECRET?: string;
  MASE_STREAM_BOT_TOKEN?: string;
}
type TgFile = { file_id?: string; file_unique_id?: string; file_name?: string; file_size?: number; mime_type?: string };
type TgMessage = {
  message_id?: number;
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string };
  text?: string;
  caption?: string;
  video?: TgFile;
  document?: TgFile;
};
const telegram = async (env: Env, method: string, payload: Record<string, unknown>) => {
  const token = String(env.MASE_STREAM_BOT_TOKEN || "").trim();
  if (!token) throw new Error("Stream Manager bot token is not configured.");
  const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; description?: string; result?: any };
  if (!response.ok || !data.ok) throw new Error(data.description || "Telegram " + method + " failed.");
  return data.result;
};
const clean = (s: string) => s.replace(/\.(mkv|mp4|m4v|webm|mov)$/i, "")
  .replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
const parseMetadata = (fileName: string, caption: string) => {
  const combined = (caption + "\n" + fileName).trim();
  const seasonEpisode = combined.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i);
  const explicitTitle = caption.match(/(?:^|\n)\s*(?:title|name)\s*:\s*(.+)/i)?.[1]?.trim();
  const rawName = explicitTitle || clean(fileName);
  const title = rawName
    .replace(/\bS\d{1,2}\s*E\d{1,3}\b/ig, " ")
    .replace(/\b(2160p|1440p|1080p|720p|576p|540p|480p|360p|x265|h265|hevc|x264|h264|av1|10bit|8bit)\b/ig, " ")
    .replace(/\b(19\d{2}|20\d{2})\b/g, " ")
    .replace(/\s+/g, " ").trim();
  const quality = combined.match(/\b(2160p|1440p|1080p|720p|576p|540p|480p|360p)\b/i)?.[1]?.toLowerCase() || "Unknown";
  const codec = combined.match(/\b(x265|h265|hevc|x264|h264|av1)\b/i)?.[1]?.toLowerCase() || "Unknown";
  const year = Number(combined.match(/\b(19\d{2}|20\d{2})\b/)?.[1] || 0) || null;
  const season = seasonEpisode ? Number(seasonEpisode[1]) : 0;
  const episode = seasonEpisode ? Number(seasonEpisode[2]) : 0;
  const kind = seasonEpisode || /(?:^|\n)\s*type\s*:\s*drama/i.test(caption) ? "drama" : "movie";
  const language = caption.match(/(?:^|\n)\s*language\s*:\s*(.+)/i)?.[1]?.trim() || "Unknown";
  return { title: title || "Untitled upload", year, season, episode, kind, quality, codec, language };
};
const reply = (env: Env, chatId: string | number, text: string, markup?: unknown) =>
  telegram(env, "sendMessage", { chat_id: chatId, text, ...(markup ? { reply_markup: markup } : {}) });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const secret = String(env.MASE_STREAM_BOT_WEBHOOK_SECRET || "").trim();
  if (!secret) return json({ ok: false, error: "Media Vault encryption is not configured." }, 503);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return json({ ok: false }, 401);
  const config = await loadMediaVaultConfig(env.DB, secret);
  if (!config) return json({ ok: false, error: "Media Vault manager bot setup is incomplete." }, 503);
  const adminId = config.adminChatId;
  const vaultChatId = config.vaultChatId;
  const runtimeEnv: Env = { ...env, MASE_STREAM_BOT_TOKEN: config.token };
  const update = await request.json().catch(() => ({})) as { update_id?: number; message?: TgMessage };
  const msg = update.message;
  if (!msg || String(msg.chat?.type || "") !== "private" ||
      String(msg.from?.id || "") !== adminId || String(msg.chat?.id || "") !== adminId) {
    return json({ ok: true, ignored: true });
  }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_media_assets (
    id TEXT PRIMARY KEY, title_id TEXT, media_kind TEXT NOT NULL, title TEXT NOT NULL,
    release_year INTEGER, season INTEGER NOT NULL DEFAULT 0, episode INTEGER NOT NULL DEFAULT 0,
    episode_title TEXT, quality TEXT NOT NULL DEFAULT 'Unknown', codec TEXT NOT NULL DEFAULT 'Unknown',
    container_format TEXT NOT NULL DEFAULT 'Unknown', language TEXT NOT NULL DEFAULT 'Unknown',
    file_name TEXT NOT NULL, file_size INTEGER, mime_type TEXT, vault_chat_id TEXT NOT NULL,
    vault_message_id INTEGER NOT NULL, file_unique_id TEXT, source_update_id INTEGER UNIQUE, source_bot TEXT NOT NULL DEFAULT 'MaseNetStreamManagerBot',
    status TEXT NOT NULL DEFAULT 'staged', rights_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(vault_chat_id,vault_message_id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_media_updates (
    update_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL DEFAULT(datetime('now'))
  )`).run();
  const updateId = Number.isSafeInteger(update.update_id) ? Number(update.update_id) : null;
  if (updateId !== null) {
    const prior = await env.DB.prepare("SELECT id FROM telegram_media_assets WHERE source_update_id=?").bind(updateId).first<{id:string}>();
    if (prior) return json({ ok:true, duplicate:true, mediaId:prior.id });
  }
  const incoming = msg.video || msg.document;
  if (!incoming?.file_id || !msg.message_id) {
    await reply(runtimeEnv, adminId, "🎬 MaseNet Media Vault is ready. Send a video or document file here. I will store it in the private vault and organise its metadata.\n\nBest filename format: Title (2026) S01E02 1080p x265.mkv\nFor a movie, omit SxxExx. You can add a caption with Title:, Type:, and Language:.");
    return json({ ok: true, help: true });
  }
  const fileName = String(incoming.file_name || (msg.video ? "video.mp4" : "document.bin")).slice(0, 255);
  const caption = String(msg.caption || "").slice(0, 1500);
  const meta = parseMetadata(fileName, caption);
  const copied = await telegram(env, "copyMessage", {
    chat_id: vaultChatId, from_chat_id: adminId, message_id: msg.message_id,
    disable_notification: true
  }) as { message_id?: number };
  if (!copied?.message_id) throw new Error("Telegram did not return a vault message reference.");
  const id = crypto.randomUUID();
  const format = fileName.split(".").pop()?.toLowerCase() || "unknown";
  await env.DB.prepare(`INSERT INTO telegram_media_assets
    (id,media_kind,title,release_year,season,episode,quality,codec,language,container_format,file_name,file_size,mime_type,vault_chat_id,vault_message_id,file_unique_id,source_update_id,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'staged')`)
    .bind(id, meta.kind, meta.title, meta.year, meta.season, meta.episode, meta.quality, meta.codec,
      meta.language, format, fileName, Number(incoming.file_size || 0) || null, String(incoming.mime_type || ""), vaultChatId,
      copied.message_id, String(incoming.file_unique_id || ""), updateId).run();
  if (updateId !== null) {
    await env.DB.prepare("INSERT OR IGNORE INTO telegram_media_updates(update_id) VALUES (?)").bind(updateId).run();
  }
  const category = meta.kind === "movie" ? "🎞 MOVIE" : "📺 DRAMA EPISODE";
  const episode = meta.kind === "drama" ? "\nEpisode: S" + String(meta.season).padStart(2,"0") + "E" + String(meta.episode).padStart(2,"0") : "";
  await reply(runtimeEnv, adminId,
    "✅ STORED IN PRIVATE TELEGRAM VAULT\n\n" + category + "\nTitle: " + meta.title +
    (meta.year ? "\nYear: " + meta.year : "") + episode + "\nQuality: " + meta.quality +
    "\nCodec: " + meta.codec + "\nFormat: " + format.toUpperCase() +
    "\n\nStatus: STAGED — not yet visible to MaseNet users.\nVault ID: " + id +
    "\n\nThe file is safely referenced by its private Telegram message. Website publishing and public-bot delivery remain disabled until the title is approved and rights are confirmed.");
  return json({ ok: true, stored: true, mediaId: id, status: "staged" });
};
