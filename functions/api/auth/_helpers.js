const COOKIE = "masenet_user";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join("");
const fromHex = value => new Uint8Array((value.match(/.{2}/g) || []).map(v => parseInt(v, 16)));
export function json(body, status = 200, extra = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", ...extra } });
}
export function originAllowed(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}
export async function ensureTables(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`).run();
}
export async function passwordHash(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: fromHex(saltHex), iterations: 210000, hash: "SHA-256" }, key, 256);
  return hex(bits);
}
export async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}
export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
export function cookieToken(request) {
  const raw = request.headers.get("Cookie") || "";
  const match = raw.match(/(?:^|;\\s*)masenet_user=([^;]*)/);
  return match ? match[1] : "";
}
export async function createSession(DB, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_SECONDS;
  await DB.prepare("INSERT INTO user_sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)").bind(tokenHash,userId,expiresAt,now).run();
  return { token, expiresAt };
}
export async function currentUser(DB, request) {
  const token = cookieToken(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await DB.prepare("SELECT u.id,u.email,u.created_at,s.expires_at FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? LIMIT 1").bind(tokenHash,now).first();
  return row || null;
}
