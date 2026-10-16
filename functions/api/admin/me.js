const COOKIE = "masenet_admin";
async function sha256(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
function getCookie(request) {
  const raw = request.headers.get("Cookie") || "";
  const match = raw.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]*)"));
  return match ? match[1] : "";
}
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ authenticated: false, error: "Authentication service is not configured." }, 503);
  const token = getCookie(request);
  if (!/^[a-f0-9]{64}$/i.test(token)) return json({ authenticated: false }, 401);
  try {
    const tokenHash = await sha256(token);
    const session = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ? LIMIT 1").bind(tokenHash).first();
    const now = Math.floor(Date.now() / 1000);
    if (!session || Number(session.expires_at) <= now) return json({ authenticated: false }, 401);
    return json({ authenticated: true, expiresAt: Number(session.expires_at) });
  } catch {
    return json({ authenticated: false, error: "Authentication service failed." }, 500);
  }
}
