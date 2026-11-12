interface Env {
  DB: D1Database;
}

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sessionCookie(request: Request): string | null {
  for (const item of (request.headers.get("Cookie") || "").split(";")) {
    const index = item.indexOf("=");
    if (index > 0 && item.slice(0, index).trim() === "masetv_user_session") {
      try { return decodeURIComponent(item.slice(index + 1).trim()); }
      catch { return null; }
    }
  }
  return null;
}

const REVERIFICATION_EXEMPT_PATHS = new Set([
  "/api/telegram/review-status",
  "/api/telegram/access-status",
  "/api/telegram/verify",
  "/api/auth/logout",
]);

export const onRequest: PagesFunction<Env> = async ({ request, env, next }) => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return next();

  const token = sessionCookie(request);
  if (!token) return next();

  try {
    const session = await env.DB.prepare(
      "SELECT u.email FROM site_user_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>datetime('now')"
    ).bind(await sha256(token)).first<{ email: string }>();

    // Google users and unrelated cookies keep their existing API behavior.
    if (!session?.email?.startsWith("telegram-")) return next();

    const chatId = session.email.slice("telegram-".length).replace(/@telegram\.local$/, "");
    if (!/^\d+$/.test(chatId)) return json({ error: "Telegram account session is invalid." }, 401);

    if (REVERIFICATION_EXEMPT_PATHS.has(url.pathname)) return next();

    await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_access_reviews (chat_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'clear',reason TEXT NOT NULL DEFAULT '',flagged_at TEXT,deadline_at TEXT,updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    const review = await env.DB.prepare(
      "SELECT status,deadline_at FROM telegram_access_reviews WHERE chat_id=?"
    ).bind(chatId).first<{ status: string; deadline_at: string | null }>();

    if (!review || !["warning", "restricted", "submitted"].includes(review.status)) return next();

    let status = review.status;
    if (["warning", "submitted"].includes(status) && review.deadline_at) {
      await env.DB.prepare(
        "UPDATE telegram_access_reviews SET status='restricted',updated_at=datetime('now') WHERE chat_id=? AND status IN ('warning','submitted') AND datetime(deadline_at)<=datetime('now')"
      ).bind(chatId).run();
      const latest = await env.DB.prepare(
        "SELECT status FROM telegram_access_reviews WHERE chat_id=?"
      ).bind(chatId).first<{ status: string }>();
      status = latest?.status || status;
    }

    if (status === "restricted") {
      return json({
        error: status === "restricted"
          ? "This MaseNet account is restricted pending manual approval of a genuine replacement screenshot."
          : "This account is under YouTube re-verification. Submit a genuine replacement screenshot and wait for manual approval.",
        verificationRequired: true,
        reviewStatus: status,
      }, 403);
    }
    return next();
  } catch (error) {
    // Fail closed for a valid Telegram session if review state cannot be checked.
    console.error("MaseNet Telegram API restriction middleware failed:", error instanceof Error ? error.message : String(error));
    return json({ error: "MaseNet could not verify this account's access status. Retry shortly." }, 503);
  }
};
