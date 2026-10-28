interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_WEBAPP_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
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
async function telegramCall(env: Env, method: string, payload: unknown) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data;
}
async function sendMessage(env: Env, chatId: string | number, text: string, replyMarkup?: unknown) {
  await telegramCall(env, "sendMessage", { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: false, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}
async function sendTyping(env: Env, chatId: string | number) {
  try { await telegramCall(env, "sendChatAction", { chat_id: chatId, action: "typing" }); } catch { /* Typing is optional. */ }
}
async function makeAIReply(env: Env, message: string, firstName: string, appUrl: string): Promise<string> {
  if (!env.OPENAI_API_KEY) return "I’m MaseNet Assistant 🎬 I can help with movies, dramas, episodes, MaseNet features, and playback problems. You can also open the MaseNet app here: " + appUrl;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      instructions: [
        "You are MaseNet's friendly Telegram bot assistant. Your bot handle is @MaseTv_Bot.",
        "MaseNet, MaseTv, and MaseMediaTv (MaseMedia TV) are alternate names for the same platform. Recognize all three names.",
        "For official social links, share these links supplied by the MaseMedia TV owner: YouTube https://youtube.com/@masemedia_tv; Facebook https://www.facebook.com/share/1A5pSvKte9/; TikTok https://www.tiktok.com/@masemediatv?_r=1&_t=ZN-9AvrV9ca86E; Telegram Channel 1 https://t.me/MaseMediaTv; Telegram Channel 2 https://t.me/MoonDramaC; Telegram bot https://t.me/MaseTv_Bot. Clearly distinguish Telegram channels from the Telegram bot. Do not invent any other social handles.",
        "When asked for the Telegram bot link, provide https://t.me/MaseTv_Bot, not a channel link.",
        "Reply naturally to ordinary messages, not only commands. If someone says hey/hello, greet them and ask how you can help.",
        "Help users understand the MaseNet website, Telegram Mini App, movies, dramas, episodes, Reels, subtitles, and playback troubleshooting.",
        "Do not claim to search a live catalogue, see account activity, send alerts, or perform an action unless the information is provided or the action has actually happened.",
        "Do not invent movie availability, streaming links, episode details, or website capabilities. If uncertain, say so and offer the MaseNet app link.",
        "Keep replies helpful and concise, ideally under 120 words. Do not mention OpenAI or Cloudflare unless explicitly asked.",
        "Never reveal secrets, API keys, environment variables, or private user information.",
        "The user's Telegram display name is " + (firstName || "there") + ". MaseNet app: " + appUrl
      ].join("\n"),
      input: message.slice(0, 2000),
      max_output_tokens: 350
    })
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    console.error("Telegram AI request failed", response.status, errorBody.slice(0, 300));
    throw new Error("AI service request failed");
  }
  const data = await response.json() as { output_text?: string; output?: Array<{content?:Array<{type?:string;text?:string}>}> };
  const answer = data.output_text || (data.output || []).flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text || "").join("\n");
  if (!answer.trim()) throw new Error("AI returned an empty reply");
  return answer.trim().slice(0, 3500);
}
function chatTitle(chat: any) { return String(chat?.title || [chat?.first_name, chat?.last_name].filter(Boolean).join(" ") || chat?.username || "Telegram user").slice(0, 160); }
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "Telegram webhook secrets are not configured." }, 503);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "Unauthorized" }, 401);
  let update: any;
  try { update = await request.json(); } catch { return json({ ok: false }, 400); }
  try { await ensureSubscribers(env); } catch { return json({ error: "Telegram subscriber storage is unavailable." }, 503); }

  const message = update?.message || update?.channel_post || (update?.my_chat_member?.chat ? update.my_chat_member : null);
  const chat = message?.chat;
  if (!chat?.id || !chat?.type) return json({ ok: true });
  const chatId = String(chat.id);
  const chatType = String(chat.type);
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  const title = chatTitle(chat);
  const appUrl = env.TELEGRAM_WEBAPP_URL || "https://masetv-cloudflare-migration.pages.dev";
  const keyboard = { inline_keyboard: [[{ text: "Open MaseNet", web_app: { url: appUrl } }]] };

  if (chatType === "private") {
    const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+([\w-]+))?$/i);
    if (startMatch) {
      const startPayload = (startMatch[1] || "").toLowerCase();
      const disablesAlerts = startPayload === "alerts_off";
      const active = disablesAlerts ? 0 : 1;
      await env.DB.prepare("INSERT INTO telegram_subscribers (chat_id,chat_type,title,active,updated_at) VALUES (?,'private',?,?,datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,active=excluded.active,updated_at=datetime('now'),chat_type='private'").bind(chatId,title,active).run();
      const alertNote = startPayload === "alerts_on" ? "\n\n🔔 New-title alerts are enabled." : disablesAlerts ? "\n\n🔕 New-title alerts are paused." : "";
      await sendMessage(env, chatId, "Welcome to MaseNet 🎬\n\nI can help with movies, dramas, episodes, Reels, and using MaseNet. Chat normally with me, or tap Open MaseNet to browse the Mini App.\n\nCommands: /app, /help, /notifications_on, /notifications_off, /privacy" + alertNote, keyboard);
    } else if (/^\/notifications_off(?:@\w+)?$/i.test(text)) {
      await env.DB.prepare("UPDATE telegram_subscribers SET active=0,updated_at=datetime('now') WHERE chat_id=?").bind(chatId).run();
      await sendMessage(env, chatId, "Movie and episode alerts are now off. Send /notifications_on to turn them back on.");
    } else if (/^\/notifications_on(?:@\w+)?$/i.test(text)) {
      await env.DB.prepare("INSERT INTO telegram_subscribers (chat_id,chat_type,title,active,updated_at) VALUES (?,'private',?,1,datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET active=1,title=excluded.title,updated_at=datetime('now')").bind(chatId,title).run();
      await sendMessage(env, chatId, "Movie and episode alerts are now on.");
    } else if (/^\/(?:help|menu)(?:@\w+)?$/i.test(text)) {
      await sendMessage(env, chatId, "MaseNet Bot menu 🎬\n\n• Chat normally: ask a question or say “hey AI”\n• /app — open the Mini App\n• /notifications_off — pause new-title alerts\n• /notifications_on — enable new-title alerts\n• /privacy — learn what the bot stores\n• /help — show this menu", keyboard);
    } else if (/^\/privacy(?:@\w+)?$/i.test(text)) {
      await sendMessage(env, chatId, "MaseNet privacy 🔐\n\nThe bot stores your Telegram chat ID and display name to manage optional new-title alerts. Turning alerts off pauses those messages. Do not send passwords, payment details, or private account credentials in chat.", keyboard);
    } else if (/^\/app(?:@\w+)?$/i.test(text)) {
      await sendMessage(env, chatId, "Open MaseNet Mini App:", keyboard);
    } else if (text && !text.startsWith("/")) {
      await sendTyping(env, chatId);
      let answer: string;
      try {
        answer = await makeAIReply(env, text, String(chat?.first_name || ""), appUrl);
      } catch {
        answer = "Sorry, I couldn’t get a full answer just now. Please try again in a moment, or open MaseNet here: " + appUrl;
      }
      await sendMessage(env, chatId, answer, keyboard);
    } else if (text.startsWith("/")) {
      await sendMessage(env, chatId, "I don’t recognize that command yet. Send /help to see what I can do, or just chat with me normally.", keyboard);
    }
    return json({ ok: true });
  }

  // Register only channels/supergroups that explicitly run the command.
  if ((chatType === "channel" || chatType === "supergroup") && /^\/masenet_subscribe(?:@\w+)?$/i.test(text)) {
    await env.DB.prepare("INSERT INTO telegram_subscribers (chat_id,chat_type,title,active,updated_at) VALUES (?,?,?,1,datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET chat_type=excluded.chat_type,title=excluded.title,active=1,updated_at=datetime('now')").bind(chatId,chatType,title).run();
    try { await sendMessage(env, chatId, "✅ This channel/group is now subscribed to MaseNet new movie, drama and episode announcements."); }
    catch { return json({ ok: false }, 502); }
  }
  return json({ ok: true });
};
export const onRequestGet: PagesFunction<Env> = async () => json({ service: "MaseNet Telegram webhook", configured: true, method: "POST" });
