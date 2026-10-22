interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_WEBAPP_URL?: string;
}
const json = (data: unknown, status = 200) => Response.json(data, { status });

async function sendMessage(env: Env, chatId: number, text: string, replyMarkup?: unknown) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) })
  });
  if (!response.ok) throw new Error("Telegram sendMessage failed");
}
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET)
    return json({ error: "Telegram webhook secrets are not configured." }, 503);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET)
    return json({ error: "Unauthorized" }, 401);
  let update: any;
  try { update = await request.json(); } catch { return json({ ok: false }, 400); }
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!Number.isSafeInteger(chatId) || !text) return json({ ok: true });

  const appUrl = env.TELEGRAM_WEBAPP_URL || "https://masetv-cloudflare-migration.pages.dev";
  const keyboard = { inline_keyboard: [[{ text: "Open MaseNet", web_app: { url: appUrl } }]] };
  try {
    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
      await sendMessage(env, chatId,
        "Welcome to MaseNet 🎬\n\nOpen the mini app to browse the catalogue, search dramas and continue watching. You can also send a drama or episode title here to search.",
        keyboard);
    } else if (/^\/help(?:@\w+)?$/i.test(text)) {
      await sendMessage(env, chatId, "Send a drama, movie or episode title to search. Use /start to open MaseNet.");
    } else if (/^\/app(?:@\w+)?$/i.test(text)) {
      await sendMessage(env, chatId, "Open MaseNet Mini App:", keyboard);
    } else {
      // Search is intentionally not fabricated: wire this to the catalogue query endpoint next.
      await sendMessage(env, chatId, `I received: “${text.slice(0, 180)}”\n\nOpen MaseNet to search the catalogue. Full Telegram-to-catalogue search will be connected to the same database next.`, keyboard);
    }
  } catch {
    // Acknowledge safely; Telegram retries should not expose credentials or provider details.
    return json({ ok: false }, 502);
  }
  return json({ ok: true });
};
export const onRequestGet: PagesFunction<Env> = async () =>
  json({ service: "MaseNet Telegram webhook", configured: true, method: "POST" });
