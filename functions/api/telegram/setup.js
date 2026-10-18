import { json } from "../auth/_helpers.js";

const APP_URL = "https://masenet.pages.dev";
const WEBHOOK_URL = APP_URL + "/api/telegram/webhook";

export async function onRequestPost({ request, env }) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: "Production Telegram secrets are missing. Add both secrets and redeploy." }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const supplied = typeof body?.setupSecret === "string" ? body.setupSecret : "";
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!supplied || supplied.length !== expected.length) {
    return json({ ok: false, error: "Secret did not match." }, 403);
  }
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return json({ ok: false, error: "Secret did not match." }, 403);

  let response;
  try {
    response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/setWebhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: WEBHOOK_URL,
        secret_token: expected,
        allowed_updates: ["message"],
        drop_pending_updates: false
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      return json({ ok: false, error: "Telegram rejected webhook registration. Check the bot token in Cloudflare and redeploy." }, 502);
    }
  } catch {
    return json({ ok: false, error: "Could not reach Telegram to register the webhook." }, 502);
  }

  return json({ ok: true, message: "Telegram webhook registered.", webhook_url: WEBHOOK_URL });
}
