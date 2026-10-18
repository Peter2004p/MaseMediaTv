const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
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
  const setupKey = env.ADMIN_SETUP_KEY;
  if (typeof setupKey !== "string" || setupKey.length < 32) {
    return json({ error: "First-admin setup is disabled until the preview-only ADMIN_SETUP_KEY secret is configured." }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  if (typeof body?.setupKey !== "string" || !safeEqual(body.setupKey, setupKey)) return json({ error: "Setup key rejected." }, 403);
  if (typeof body?.password !== "string" || body.password.length < 12 || body.password.length > 1024) {
    return json({ error: "Choose an admin password with at least 12 characters." }, 400);
  }
  try {
    const existing = await env.DB.prepare("SELECT id FROM admins WHERE id = 1 LIMIT 1").first();
    if (existing) return json({ error: "An admin is already configured. Use the normal sign-in screen." }, 409);
    const salt = hex(crypto.getRandomValues(new Uint8Array(24)));
    const passwordHash = await sha256(body.password + salt);
    const result = await env.DB.prepare("INSERT INTO admins (id, salt, password_hash) SELECT 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admins WHERE id = 1)").bind(salt, passwordHash).run();
    if (!result.meta?.changes) return json({ error: "Admin setup has already been completed." }, 409);
    return json({ ok: true, message: "Admin account created. Sign in with your new password." }, 201);
  } catch {
    return json({ error: "Could not create the initial admin account." }, 500);
  }
}
export async function onRequest({ request }) {
  return json({ error: "Use POST to configure the initial admin." }, 405);
}
