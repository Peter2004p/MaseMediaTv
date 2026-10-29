import { Env, json, requireAdmin } from "../auth/_shared";

type TelegramEnv = Env & { TELEGRAM_BOT_TOKEN?: string };
type TelegramResult<T> = { ok?: boolean; result?: T; description?: string };
async function telegram<T>(token: string, method: string, payload?: unknown): Promise<TelegramResult<T>> {
  const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "content-type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return await response.json().catch(() => ({})) as TelegramResult<T>;
}
async function ensureSubscribers(env: Env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_subscribers (
    chat_id TEXT PRIMARY KEY, chat_type TEXT NOT NULL, title TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}
function normalizeChatInput(input: unknown) {
  let value = String(input || "").trim();
  if (!value) return "";
  value = value.replace(/^https?:\/\/(?:www\.)?t\.me\//i, "").replace(/^@/, "").replace(/\/$/, "");
  if (value.includes("/") || value.includes("?") || value.includes("#")) return "";
  return value.startsWith("-100") ? value : "@" + value;
}
export const onRequestGet: PagesFunction<TelegramEnv> = async ({ request, env }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  await ensureSubscribers(env);
  const rows = await env.DB.prepare("SELECT chat_id,chat_type,title,active,created_at,updated_at FROM telegram_subscribers WHERE chat_type IN ('channel','supergroup') ORDER BY active DESC,title COLLATE NOCASE").all<Record<string, unknown>>();
  return json({ channels: rows.results || [] });
};
export const onRequestPost: PagesFunction<TelegramEnv> = async ({ request, env }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Telegram bot token is not configured on Cloudflare." }, 503);
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return json({ error: "Enter a Telegram channel username or link." }, 400); }
  if (body.action === "disable") {
    const chatId = String(body.chatId || "").trim();
    if (!chatId) return json({ error: "A channel ID is required." }, 400);
    await ensureSubscribers(env);
    await env.DB.prepare("UPDATE telegram_subscribers SET active=0,updated_at=datetime('now') WHERE chat_id=? AND chat_type IN ('channel','supergroup')").bind(chatId).run();
    return json({ ok: true });
  }
  const chatInput = normalizeChatInput(body.channel);
  if (!chatInput) return json({ error: "Enter a valid public channel username, t.me channel link, or numeric channel ID." }, 400);
  const chat = await telegram<{id:number;type:string;title?:string;username?:string}>(env.TELEGRAM_BOT_TOKEN, "getChat", { chat_id: chatInput });
  if (!chat.ok || !chat.result) return json({ error: "Telegram could not find this channel. Use its public @username or add the bot to the channel first. " + String(chat.description || "") }, 400);
  if (chat.result.type !== "channel" && chat.result.type !== "supergroup") return json({ error: "Only Telegram channels or supergroups can receive announcements." }, 400);
  const me = await telegram<{id:number;username?:string}>(env.TELEGRAM_BOT_TOKEN, "getMe");
  if (!me.ok || !me.result) return json({ error: "The bot identity could not be verified." }, 502);
  const membership = await telegram<{status:string;can_post_messages?:boolean}>(env.TELEGRAM_BOT_TOKEN, "getChatMember", { chat_id: chat.result.id, user_id: me.result.id });
  if (!membership.ok || !membership.result || !["administrator", "creator"].includes(membership.result.status)) {
    return json({ error: "MaseTv_Bot must be an administrator in that channel before it can be registered." }, 403);
  }
  if (chat.result.type === "channel" && membership.result.status === "administrator" && membership.result.can_post_messages === false) {
    return json({ error: "The bot is an admin but does not have permission to post messages. Enable Post Messages, then register again." }, 403);
  }
  await ensureSubscribers(env);
  await env.DB.prepare("INSERT INTO telegram_subscribers (chat_id,chat_type,title,active,updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET chat_type=excluded.chat_type,title=excluded.title,active=1,updated_at=datetime('now')").bind(String(chat.result.id), chat.result.type, String(chat.result.title || chat.result.username || chatInput).slice(0,160), 1).run();
  return json({ ok: true, channel: { chat_id: String(chat.result.id), chat_type: chat.result.type, title: chat.result.title || chat.result.username || chatInput, active: 1 } }, 201);
};
export const onRequestDelete: PagesFunction<TelegramEnv> = async ({ request, env }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return json({ error: "Choose a registered channel." }, 400); }
  const chatId = String(body.chatId || "").trim();
  if (!chatId) return json({ error: "A channel ID is required." }, 400);
  await ensureSubscribers(env);
  await env.DB.prepare("UPDATE telegram_subscribers SET active=0,updated_at=datetime('now') WHERE chat_id=? AND chat_type IN ('channel','supergroup')").bind(chatId).run();
  return json({ ok: true });
};
