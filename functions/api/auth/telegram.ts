import { json, sha256 } from "./_shared";

interface Env { DB: D1Database; TELEGRAM_BOT_TOKEN?: string; }

async function hmac(key: BufferSource, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Telegram bot is not configured" }, 503);
  const body = await request.json().catch(() => ({})) as { initData?: string };
  const initData = String(body.initData || "");
  if (!initData || initData.length > 8192) return json({ error: "Missing Telegram initData" }, 400);
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  params.delete("hash");
  const authDate = Number(params.get("auth_date") || 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!hash || !Number.isSafeInteger(authDate) || authDate <= 0 || authDate > nowSeconds + 60 || nowSeconds - authDate > 86400)
    return json({ error: "Expired or invalid Telegram session" }, 401);
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  const check = entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), env.TELEGRAM_BOT_TOKEN);
  const sig = await hmac(secret, check);
  const expected = [...sig].map(x => x.toString(16).padStart(2, "0")).join("");
  if (expected.length !== hash.length) return json({ error: "Telegram signature validation failed" }, 401);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ hash.charCodeAt(i);
  if (mismatch !== 0) return json({ error: "Telegram signature validation failed" }, 401);
  let user: { id?: string | number; first_name?: string; last_name?: string } | null = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch {}
  if (!user?.id) return json({ error: "Telegram user data missing" }, 401);

  // Access is authorized only by the fresh two-channel membership check
  // performed immediately before this session-creation call in /api/telegram/enter.
  const chatId = String(user.id);
  const access = await env.DB.prepare(
    "SELECT masemedia_ok,moondramac_ok FROM telegram_access_verification WHERE chat_id=?"
  ).bind(chatId).first<{ masemedia_ok: number; moondramac_ok: number }>();
  if (!access?.masemedia_ok || !access?.moondramac_ok) {
    return json({
      error: "Join both official Telegram channels, then tap Check Membership & Enter. Membership is checked automatically; no screenshot or admin approval is required.",
      verificationRequired: true,
      membership: { masemedia: !!access?.masemedia_ok, moondramac: !!access?.moondramac_ok }
    }, 403);
  }

  await env.DB.prepare("CREATE TABLE IF NOT EXISTS site_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', picture TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT 'google', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS site_user_sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES site_users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  const userId = await sha256("masetv-user-telegram:" + chatId);
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const email = "telegram-" + chatId + "@telegram.local";
  await env.DB.prepare("INSERT INTO site_users (id,email,name,provider,last_login_at) VALUES (?,?,?,'telegram',datetime('now')) ON CONFLICT(email) DO UPDATE SET name=excluded.name,last_login_at=datetime('now')").bind(userId,email,name).run();
  const savedUser = await env.DB.prepare("SELECT id,name FROM site_users WHERE email=?").bind(email).first<{id:string;name:string}>();
  if (!savedUser) return json({ error: "Telegram account could not be created." }, 500);
  const tokenBytes = new Uint8Array(32); crypto.getRandomValues(tokenBytes);
  const session = [...tokenBytes].map(x=>x.toString(16).padStart(2,"0")).join("");
  await env.DB.prepare("INSERT INTO site_user_sessions (id_hash,user_id,expires_at) VALUES (?,?,datetime('now','+30 days'))").bind(await sha256(session),savedUser.id).run();
  return new Response(JSON.stringify({ user: { userId: savedUser.id, name: savedUser.name, email: "", provider: "telegram" } }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": "masetv_user_session=" + session + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000" }
  });
};
