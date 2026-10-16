const COOKIE = "masenet_admin";
const SESSION_SECONDS = 60 * 60 * 12;
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function json(body, status = 200, extra = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", ...extra } });
}
function cookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function getCookie(request) {
  const raw = request.headers.get("Cookie") || "";
  const match = raw.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]*)"));
  return match ? match[1] : "";
}
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "Authentication service is not configured." }, 503);
  if (request.headers.get("Origin")) {
    const origin = new URL(request.url).origin;
    if (request.headers.get("Origin") !== origin) return json({ error: "Request origin rejected." }, 403);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  if (!body || typeof body.password !== "string" || body.password.length < 1 || body.password.length > 1024) {
    return json({ error: "Enter your admin password." }, 400);
  }
  try {
    const admin = await env.DB.prepare("SELECT salt, password_hash FROM admins WHERE id = 1 LIMIT 1").first();
    if (!admin) return json({ error: "Invalid credentials." }, 401);
    // Compatibility assumption: stored hash is SHA-256 of password followed by salt.
    // Confirm this against the original provisioning code before enabling this endpoint in production.
    const candidate = await sha256(body.password + admin.salt);
    if (!safeEqual(candidate.toLowerCase(), String(admin.password_hash).toLowerCase())) {
      return json({ error: "Invalid credentials." }, 401);
    }
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = hex(tokenBytes);
    const tokenHash = await sha256(token);
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    await env.DB.prepare("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)").bind(tokenHash, expiresAt).run();
    return json({ ok: true, expiresAt }, 200, { "Set-Cookie": cookie(token, SESSION_SECONDS) });
  } catch (error) {
    return json({ error: "Login service failed. Check server configuration." }, 500);
  }
}
