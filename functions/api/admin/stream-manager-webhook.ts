import { json, requireOwner, type Env as AuthEnv } from "../auth/_shared";

interface Env extends AuthEnv {
  MASE_STREAM_BOT_TOKEN?: string;
  MASE_STREAM_BOT_WEBHOOK_SECRET?: string;
}

const WEBHOOK_URL = "https://masetv-cloudflare-migration.pages.dev/api/telegram/stream-manager";

export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
  const gate = await requireOwner(request, env);
  if (gate.response) return gate.response;
  const html = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Stream Manager</title><body style="font:16px system-ui;max-width:560px;margin:48px auto;padding:20px;background:#10131b;color:#f5f6fa"><h2>Connect MaseNet Stream Manager</h2><p>This will register only <b>@MaseNetStreamManagerBot</b> to the dedicated Stream Manager endpoint. Your existing @MaseTv_Bot webhook will not be changed.</p><p style="overflow-wrap:anywhere;color:#aab4c8">${WEBHOOK_URL}</p><form method="post"><button style="padding:14px 20px;border:0;border-radius:12px;background:#5b7cfa;color:white;font-weight:700;font-size:16px">Register Stream Manager webhook</button></form><p style="color:#aab4c8;font-size:13px">This action uses the bot credentials already stored securely in Cloudflare. No token needs to be entered here.</p></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
};

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const gate = await requireOwner(request, env);
  if (gate.response) return gate.response;
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) return json({ ok: false, error: "Same-origin confirmation is required." }, 403);

  const token = String(env.MASE_STREAM_BOT_TOKEN || "").trim();
  const secret = String(env.MASE_STREAM_BOT_WEBHOOK_SECRET || "").trim();
  if (!token || !secret) return json({ ok: false, error: "The Stream Manager bot token or webhook secret is missing from Cloudflare Production secrets." }, 503);
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) return json({ ok: false, error: "The configured webhook secret contains unsupported characters. Regenerate it using letters, numbers, underscores, or hyphens." }, 500);

  const callTelegram = async (method: string, payload?: Record<string, unknown>) => {
    const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: payload ? "POST" : "GET",
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined
    });
    const data = await response.json().catch(() => ({})) as { ok?: boolean; description?: string; result?: Record<string, unknown> };
    if (!response.ok || !data.ok) throw new Error(data.description || "Telegram API request failed.");
    return data.result || {};
  };

  try {
    await callTelegram("setWebhook", {
      url: WEBHOOK_URL,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false
    });
    const info = await callTelegram("getWebhookInfo");
    if (String(info.url || "") !== WEBHOOK_URL) {
      return json({ ok: false, error: "Telegram accepted the registration request, but the webhook URL did not verify. Please retry." }, 502);
    }
    return json({
      ok: true,
      message: "The dedicated MaseNet Stream Manager webhook is registered and verified.",
      webhook: info.url,
      pendingUpdates: Number(info.pending_update_count || 0),
      lastErrorDate: info.last_error_date || null,
      lastErrorMessage: info.last_error_message || null
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Could not register the Stream Manager webhook." }, 502);
  }
};
