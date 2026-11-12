interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  PROMO_CRON_SECRET?: string;
  TELEGRAM_PROMO_CRON_SECRET?: string;
  TELEGRAM_WEBAPP_URL?: string;
  TELEGRAM_MINI_APP_URL?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const secrets = [env.PROMO_CRON_SECRET, env.TELEGRAM_PROMO_CRON_SECRET]
    .map(value => String(value || "").trim()).filter(Boolean);
  const authorization = String(request.headers.get("authorization") || "").trim();
  if (!secrets.length || !secrets.some(secret => authorization === "Bearer " + secret)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) {
    return json({ ok: false, error: "Telegram bot or D1 binding is unavailable." }, 503);
  }

  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_access_reviews (chat_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'clear',reason TEXT NOT NULL DEFAULT '',flagged_at TEXT,deadline_at TEXT,updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_access_review_notifications (chat_id TEXT PRIMARY KEY,notified_at TEXT NOT NULL DEFAULT (datetime('now')))").run();

    const due = await env.DB.prepare(
      "UPDATE telegram_access_reviews SET status='restricted',updated_at=datetime('now') WHERE status IN ('warning','submitted') AND deadline_at IS NOT NULL AND datetime(deadline_at)<=datetime('now')"
    ).run();

    const pending = await env.DB.prepare(
      "SELECT r.chat_id,r.deadline_at FROM telegram_access_reviews r LEFT JOIN telegram_access_review_notifications n ON n.chat_id=r.chat_id WHERE r.status='restricted' AND r.flagged_at IS NOT NULL AND n.chat_id IS NULL ORDER BY r.deadline_at ASC LIMIT 100"
    ).all<{ chat_id: string; deadline_at: string | null }>();

    let notified = 0;
    let failed = 0;
    const appUrl = (env.TELEGRAM_MINI_APP_URL || env.TELEGRAM_WEBAPP_URL || "https://masetv-cloudflare-migration.pages.dev").trim();
    for (const row of pending.results || []) {
      const payload: Record<string, unknown> = {
        chat_id: row.chat_id,
        text: "⛔ MASENET — ACCOUNT RESTRICTED\n\nYour 24-hour YouTube re-verification period has ended without manual admin approval of a genuine replacement screenshot. Your MaseNet access is now restricted. Submit a genuine current screenshot; access will return only after the admin manually approves it."
      };
      if (appUrl.startsWith("https://")) {
        payload.reply_markup = { inline_keyboard: [[{ text: "Submit replacement screenshot", web_app: { url: appUrl } }]] };
      }
      try {
        const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
        });
        const result = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
        if (!response.ok || !result.ok) {
          failed++;
          console.error("MaseNet restriction DM failed:", row.chat_id, response.status, result.description || "Telegram error");
          continue;
        }
        await env.DB.prepare("INSERT INTO telegram_access_review_notifications(chat_id,notified_at) VALUES(?,datetime('now')) ON CONFLICT(chat_id) DO NOTHING").bind(row.chat_id).run();
        notified++;
      } catch (error) {
        failed++;
        console.error("MaseNet restriction notification exception:", row.chat_id, error instanceof Error ? error.message : String(error));
      }
    }

    return json({
      ok: true,
      newlyRestricted: Number(due.meta?.changes || 0),
      notified,
      failed,
      remaining: Math.max(0, (pending.results || []).length - notified - failed)
    });
  } catch (error) {
    console.error("MaseNet re-verification cron failed:", error instanceof Error ? error.message : String(error));
    return json({ ok: false, error: "Could not process expired verification reviews." }, 503);
  }
};
