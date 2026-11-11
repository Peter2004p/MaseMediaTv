interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  ADMIN_TELEGRAM_CHAT_ID?: string;
  TELEGRAM_PROMO_CRON_SECRET?: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const expected = String(env.TELEGRAM_PROMO_CRON_SECRET || "");
  if (!expected || request.headers.get("authorization") !== "Bearer " + expected) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.ADMIN_TELEGRAM_CHAT_ID) {
    return json({ ok: false, error: "Telegram bot token or admin chat is not configured" }, 503);
  }

  try {
    const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.ADMIN_TELEGRAM_CHAT_ID,
        text: "✅ MaseNet Telegram promotion test\n\nThis is a one-time admin-only delivery check. The scheduled promotion system can reach Telegram using the configured bot token. No subscribers or channels were messaged, and no promotion history was changed.",
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json() as { ok?: boolean; description?: string };
    if (!response.ok || !data.ok) {
      console.error("Admin-only Telegram test failed:", response.status, data.description || "Telegram rejected request");
      return json({ ok: false, error: "Telegram rejected the admin-only test message", telegramStatus: response.status }, 502);
    }
    return json({ ok: true, delivered: true, destination: "admin_chat_only", note: "One test message sent. No subscriber, channel, poll, or social-post delivery was attempted." });
  } catch (error) {
    console.error("Admin-only Telegram test request failed:", error instanceof Error ? error.message : String(error));
    return json({ ok: false, error: "Could not reach Telegram from the Pages function" }, 502);
  }
};

export const onRequestGet = async () => json({ ok: false, error: "Use POST from the diagnostic page." }, 405);
