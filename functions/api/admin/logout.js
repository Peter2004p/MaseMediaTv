const COOKIE = "masenet_admin";
async function sha256(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` } });
}
function getCookie(request) {
  const raw = request.headers.get("Cookie") || "";
  const match = raw.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]*)"));
  return match ? match[1] : "";
}
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "Authentication service is not configured." }, 503);
  if (request.headers.get("Origin") && request.headers.get("Origin") !== new URL(request.url).origin) return json({ ok: false, error: "Request origin rejected." }, 403);
  const token = getCookie(request);
  if (/^[a-f0-9]{64}$/i.test(token)) {
    try { await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run(); }
    catch { return json({ ok: false, error: "Could not revoke session." }, 500); }
  }
  return json({ ok: true });
}
