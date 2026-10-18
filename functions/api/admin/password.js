const COOKIE = "masenet_admin";
const SESSION_SECONDS = 60 * 60 * 12;
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
function getCookie(request) {
  const raw = request.headers.get("Cookie") || "";
  const match = raw.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]*)"));
  return match ? match[1] : "";
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "Authentication service is not configured." }, 503);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Request origin rejected." }, 403);
  const token = getCookie(request);
  if (!/^[a-f0-9]{64}$/i.test(token)) return json({ error: "Admin authentication required." }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  if (typeof body?.currentPassword !== "string" || typeof body?.newPassword !== "string" ||
      body.newPassword.length < 12 || body.newPassword.length > 1024) {
    return json({ error: "Enter your current password and a new password of at least 12 characters." }, 400);
  }
  try {
    const session = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ? LIMIT 1").bind(await sha256(token)).first();
    if (!session || Number(session.expires_at) <= Math.floor(Date.now() / 1000)) return json({ error: "Admin session expired. Sign in again." }, 401);
    const admin = await env.DB.prepare("SELECT salt, password_hash FROM admins WHERE id = 1 LIMIT 1").first();
    if (!admin || !safeEqual(await sha256(body.currentPassword + admin.salt), String(admin.password_hash).toLowerCase())) {
      return json({ error: "Current password is incorrect." }, 403);
    }
    const saltBytes = crypto.getRandomValues(new Uint8Array(24));
    const salt = hex(saltBytes);
    const passwordHash = await sha256(body.newPassword + salt);
    await env.DB.prepare("UPDATE admins SET salt = ?, password_hash = ? WHERE id = 1").bind(salt, passwordHash).run();
    await env.DB.prepare("DELETE FROM sessions").run();
    return json({ ok: true, message: "Password changed. Please sign in again." });
  } catch {
    return json({ error: "Could not change the admin password." }, 500);
  }
}
export async function onRequest({ request }) {
  return json({ error: "Use POST to change the admin password." }, 405);
}
