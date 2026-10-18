import { json, originAllowed, ensureTables, passwordHash, createSession, sessionCookie } from "./_helpers.js";

const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join("");
async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function validateInitData(initData, botToken) {
  if (typeof initData !== "string" || !initData || initData.length > 8192) throw new Error("Open MaseNet from its Telegram Mini App.");
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) throw new Error("Telegram authentication data is invalid.");
  params.delete("hash");
  params.delete("signature");
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + v).join("\n");
  const secretKey = await hmac(encoder.encode("WebAppData"), botToken);
  const expectedHash = hex(await hmac(secretKey, dataCheckString));
  if (!constantTimeEqual(expectedHash, receivedHash.toLowerCase())) throw new Error("Telegram authentication could not be verified.");
  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > 86400) throw new Error("Telegram login expired. Close and reopen MaseNet from Telegram.");
  let user;
  try { user = JSON.parse(params.get("user") || ""); } catch { throw new Error("Telegram did not provide a valid user profile."); }
  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) throw new Error("Telegram user identity is missing.");
  return user;
}
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "Account database is unavailable." }, 503);
  if (!originAllowed(request)) return json({ error: "Request origin rejected." }, 403);
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Telegram login is not configured on the server yet." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid Telegram login request." }, 400); }
  let telegramUser;
  try { telegramUser = await validateInitData(body?.initData, env.TELEGRAM_BOT_TOKEN); }
  catch (error) { return json({ error: error.message || "Telegram authentication failed." }, 401); }
  try {
    await ensureTables(env.DB);
    const email = "telegram_" + String(telegramUser.id) + "@telegram.masenet.local";
    let user = await env.DB.prepare("SELECT id,email,created_at FROM masenet_account_users WHERE email=? LIMIT 1").bind(email).first();
    if (!user) {
      const id = "tg_" + String(telegramUser.id);
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const randomPassword = hex(crypto.getRandomValues(new Uint8Array(32)));
      const hash = await passwordHash(randomPassword, salt);
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare("INSERT INTO masenet_account_users (id,email,password_salt,password_hash,created_at) VALUES (?,?,?,?,?)").bind(id,email,salt,hash,now).run();
      user = { id, email, created_at: now };
    }
    const session = await createSession(env.DB, user.id);
    return json({ ok: true, user: { id: user.id, email: user.email, createdAt: user.created_at, provider: "telegram", telegram: { id: String(telegramUser.id), firstName: String(telegramUser.first_name || "").slice(0, 64), username: String(telegramUser.username || "").slice(0, 64) } } }, 200, { "Set-Cookie": sessionCookie(session.token) });
  } catch {
    return json({ error: "Could not complete Telegram sign-in. Please try again." }, 500);
  }
}
