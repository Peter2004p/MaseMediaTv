import { json, requireAdmin } from "../auth/_shared";
interface Env {
  DB: D1Database;
  ADMIN_EMAIL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;
  if (!env.TELEGRAM_BOT_TOKEN) {
    return json({ error: "Add TELEGRAM_BOT_TOKEN as a Cloudflare Pages secret first." }, 503);
  }
  if (!env.TELEGRAM_WEBHOOK_SECRET || !/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ error: "Add TELEGRAM_WEBHOOK_SECRET as a Cloudflare Pages secret. Use 32–256 letters, numbers, underscores, or hyphens." }, 503);
  }

  const origin = new URL(request.url).origin;
  const webhookUrl = origin + "/api/telegram/webhook/masetv";
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/setWebhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      drop_pending_updates: false,
      allowed_updates: ["message", "edited_message"],
      secret_token: env.TELEGRAM_WEBHOOK_SECRET
    })
  });
  const data = await response.json().catch(() => ({ ok: false, description: "Telegram returned an unreadable response" })) as { ok?: boolean; description?: string };
  if (!response.ok || !data.ok) {
    return json({ error: data.description || "Telegram webhook registration failed." }, 502);
  }

  await env.DB.prepare(
    "INSERT INTO site_settings(key,value_json,updated_at) VALUES('telegram_webhook',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=datetime('now')"
  ).bind(JSON.stringify({ url: webhookUrl, configured: true, verified: true })).run();

  return json({ ok: true, webhookUrl, description: data.description || "Webhook registered and verified" });
};
