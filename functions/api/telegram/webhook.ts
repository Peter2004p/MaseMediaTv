interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_WEBAPP_URL?: string;
}
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function ensureSubscribers(env: Env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_subscribers (
    chat_id TEXT PRIMARY KEY,
    chat_type TEXT NOT NULL,
    title TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}
async function sendMessage(env: Env, chatId: string | number, text: string, replyMarkup?: unknown) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) })
  });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
  if (!response.ok || !data.ok) throw new Error(data.description || "Telegram sendMessage failed");
}
function chatTitle(chat: any) { return String(chat?.title || [chat?.first_name, chat?.last_name].filter(Boolean).join(" ") || chat?.username || "Telegram user").slice(0, 160); }
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "Telegram webhook secrets are not configured." }, 503);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "Unauthorized" }, 401);
  let update: any;
  try { update = await request.json(); } catch { return json({ ok: false }, 400); }
  try { await ensureSubscribers(env); } catch { return json({ error: "Telegram subscriber storage is unavailable." }, 503); }

  const message = update?.message || update?.channel_post || update?.my_chat_member?.chat && update?.my_chat_member;
  const chat = message?.chat;
  if (!chat?.id || !chat?.type) return json({ ok: true });
  const chatId = String(chat.id);
  const chatType = String(chat.type);
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  const title = chatTitle(chat);
  const appUrl = env.TELEGRAM_WEBAPP_URL || "https://masetv-cloudflare-migration.pages.dev";
  const keyboard = { inline_keyboard: [[{ text: "Open MaseNet", web_app: { url: appUrl } }]] };

  // A private /start opts the user in. A channel administrator can register a channel by
  // posting /masenet_subscribe in that channel after making this bot an administrator.
  if (chatType === "private") {
    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
      await env.DB.prepare("INSERT INTO telegram_subscribers (chat_id,chat_type,title,active,updated_at) VALUES (?,'private',?,1,datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,active=1,updated_at=datetime('now')").bind(chatId,title).run();
      try { await sendMessage(env, chatId, "Welcome to MaseNet 🎬\n\nYou’re subscribed to new movie, drama and episode alerts. Send /notifications_off to stop alerts, or /notifications_on to resume them.", keyboard); }
      catch { return json({ ok: false }, 502); }
    } else if (/^\/notifications_off(?:@\w+)?$/i.test(text)) {
      await env.DB.prepare("UPDATE telegram_subscribers SET active=0,updated_at=datetime('now') WHERE chat_id=?").bind(chatId).run();
      await sendMessage(env, chatId, "Movie and episode alerts are now off. Send /notifications_on to turn them back on.");
    } else if (/^\/notifications_on(?:@\w+)?$/i.test(text)) {
      await env.DB.prepare("INSERT INTO telegram_subscribers (chat_id,chat_type,title,active,updated_at) VALUES (?,'private',?,1,datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET active=1,title=excluded.title,updated_at=datetime('now')").bind(chatId,title).run();
      await sendMessage(env, chatId, "Movie and episode alerts are now on.");
    } else if (/^\/help(?:@\w+)?$/i.test(text)) {
      await sendMessage(env, chatId, "Use /start to subscribe to new movie, drama and episode alerts. /notifications_off stops alerts; /notifications_on resumes them. Send /app to open MaseNet.");
    } else if (/^\/app(?:@\w+)?$/i.test(text)) {
      await sendMessage(env, chatId, "Open MaseNet Mini App:", keyboard);
    } else if (text) {
      await sendMessage(env, chatId, "I received your message. Browse and search the catalogue in MaseNet, and I’ll keep you updated when new titles and episodes are published.", keyboard);
    }
    return json({ ok: true });
  }

  // Register only channels/supergroups that explicitly run the command. This avoids
  // sending announcements into unrelated groups where the bot happens to be present.
  if ((chatType === "channel" || chatType === "supergroup") && /^\/masenet_subscribe(?:@\w+)?$/i.test(text)) {
    await env.DB.prepare("INSERT INTO telegram_subscribers (chat_id,chat_type,title,active,updated_at) VALUES (?,?,?,1,datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET chat_type=excluded.chat_type,title=excluded.title,active=1,updated_at=datetime('now')").bind(chatId,chatType,title).run();
    try { await sendMessage(env, chatId, "✅ This channel/group is now subscribed to MaseNet new movie, drama and episode announcements."); }
    catch { return json({ ok: false }, 502); }
  }
  return json({ ok: true });
};
export const onRequestGet: PagesFunction<Env> = async () => json({ service: "MaseNet Telegram webhook", configured: true, method: "POST" });
