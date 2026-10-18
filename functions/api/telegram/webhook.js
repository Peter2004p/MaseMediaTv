import { json } from "../auth/_helpers.js";

const APP_URL = "https://masenet.pages.dev";
async function telegramCall(token, method, payload) {
  const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Telegram API request failed");
  const data = await response.json();
  if (!data.ok) throw new Error("Telegram API rejected request");
  return data.result;
}

export async function onRequestPost({ request, env }) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: "Telegram webhook is not configured." }, 503);
  }
  const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (suppliedSecret.length !== env.TELEGRAM_WEBHOOK_SECRET.length) {
    return json({ ok: false, error: "Unauthorized webhook." }, 403);
  }
  let diff = 0;
  for (let i = 0; i < suppliedSecret.length; i++) diff |= suppliedSecret.charCodeAt(i) ^ env.TELEGRAM_WEBHOOK_SECRET.charCodeAt(i);
  if (diff !== 0) return json({ ok: false, error: "Unauthorized webhook." }, 403);

  let update;
  try { update = await request.json(); } catch { return json({ ok: false }, 400); }
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!chatId || !text.startsWith("/")) return json({ ok: true });

  const command = text.split(/\s+/, 1)[0].split("@")[0].toLowerCase();
  let reply = "Welcome to MaseNet — discover movies, dramas and episodes. Tap Open MaseNet to launch the Mini App.";
  if (command === "/help") reply = "Use Open MaseNet to browse the catalog. For account sign-in, open the site from this Mini App and choose Continue with Telegram.";
  if (command === "/start") reply = "Welcome to MaseNet! Browse movies, dramas and episodes in our Mini App.";
  if (command === "/about") reply = "MaseNet is your entertainment catalog for movies, dramas and episodes.";
  try {
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: reply,
      reply_markup: { inline_keyboard: [[{ text: "🎬 Open MaseNet", web_app: { url: APP_URL } }]] }
    });
  } catch {
    return json({ ok: false, error: "Telegram message delivery failed." }, 502);
  }
  return json({ ok: true });
}
