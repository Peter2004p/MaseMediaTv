const COOKIE = "masenet_admin";
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
export function json(body, status = 200, extra = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra } });
}
export async function requireAdmin(request, env) {
  if (!env.DB) return { ok: false, response: json({ error: "Database unavailable." }, 503) };
  const raw = request.headers.get("Cookie") || "";
  const match = raw.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]*)"));
  const token = match ? match[1] : "";
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) return { ok: false, response: json({ error: "Admin sign-in required." }, 401) };
  try {
    const tokenHash = await sha256(token);
    const session = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ? LIMIT 1").bind(tokenHash).first();
    if (!session || Number(session.expires_at) <= Math.floor(Date.now() / 1000)) {
      if (session) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
      return { ok: false, response: json({ error: "Admin session expired. Sign in again." }, 401) };
    }
    return { ok: true };
  } catch {
    return { ok: false, response: json({ error: "Admin authentication could not be verified." }, 503) };
  }
}
export function checkOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}
