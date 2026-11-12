import { json, sha256 } from "./_shared";
interface Env { DB: D1Database; TELEGRAM_BOT_TOKEN?: string; }
async function hmac(key: BufferSource, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new TextEncoder().encode(data);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, bytes));
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
  if (!hash || !authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return json({ error: "Expired or invalid Telegram session" }, 401);
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  const check = entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value).join("\n");
  const keyBytes = new TextEncoder().encode("WebAppData");
  const secret = await hmac(keyBytes.buffer as ArrayBuffer, env.TELEGRAM_BOT_TOKEN);
  const sig = await hmac(secret.buffer.slice(secret.byteOffset, secret.byteOffset + secret.byteLength) as ArrayBuffer, check);
  const expected = [...sig].map(x => x.toString(16).padStart(2, "0")).join("");
  if (expected !== hash) return json({ error: "Telegram signature validation failed" }, 401);
  let user: { id?: string | number; first_name?: string; last_name?: string } | null = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch {}
  if (!user?.id) return json({ error: "Telegram user data missing" }, 401);

  // Enforce the same D1 access record used by the Telegram bot and Mini App screenshot verifier.
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_access_verification (chat_id TEXT PRIMARY KEY, youtube_ok INTEGER NOT NULL DEFAULT 0, masemedia_ok INTEGER NOT NULL DEFAULT 0, moondramac_ok INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  const chatId = String(user.id);
  const savedAccess = await env.DB.prepare("SELECT youtube_ok FROM telegram_access_verification WHERE chat_id=?").bind(chatId).first<{youtube_ok:number}>();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_access_reviews(chat_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'clear',reason TEXT NOT NULL DEFAULT '',flagged_at TEXT,deadline_at TEXT,updated_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  let review=await env.DB.prepare("SELECT status,reason,deadline_at FROM telegram_access_reviews WHERE chat_id=?").bind(chatId).first<{status:string;reason:string;deadline_at:string|null}>();
  if(review&&["warning","submitted"].includes(review.status)&&review.deadline_at){
    await env.DB.prepare("UPDATE telegram_access_reviews SET status='restricted',updated_at=datetime('now') WHERE chat_id=? AND status IN ('warning','submitted') AND datetime(deadline_at)<=datetime('now')").bind(chatId).run();
    review=await env.DB.prepare("SELECT status,reason,deadline_at FROM telegram_access_reviews WHERE chat_id=?").bind(chatId).first<{status:string;reason:string;deadline_at:string|null}>();
  }
  if(review?.status==="restricted")return json({error:"Your MaseNet account is restricted until the admin manually approves a genuine replacement screenshot.",verificationRequired:true,reviewStatus:review.status,deadlineAt:review.deadline_at},403);
  const membership = { masemedia: false, moondramac: false };
  for (const [channel, key] of [["@MaseMediaTv","masemedia"],["@MoonDramaC","moondramac"]] as const) {
    try {
      const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/getChatMember?chat_id=" + encodeURIComponent(channel) + "&user_id=" + encodeURIComponent(chatId));
      const data = await response.json().catch(() => ({})) as {ok?:boolean;result?:{status?:string}};
      membership[key] = !!response.ok && !!data.ok && ["member","administrator","creator"].includes(String(data.result?.status || ""));
    } catch { membership[key] = false; }
  }
  await env.DB.prepare("INSERT INTO telegram_access_verification (chat_id,masemedia_ok,moondramac_ok,updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET masemedia_ok=excluded.masemedia_ok,moondramac_ok=excluded.moondramac_ok,updated_at=datetime('now')").bind(chatId,membership.masemedia?1:0,membership.moondramac?1:0).run();
  const youtubeVerified = !!savedAccess?.youtube_ok;
  if (!youtubeVerified || !membership.masemedia || !membership.moondramac) {
    return json({ error: "Complete the YouTube subscription and Telegram channel checks to unlock MaseNet.", verificationRequired: true, youtubeVerified, membership }, 403);
  }

  await env.DB.prepare("CREATE TABLE IF NOT EXISTS site_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', picture TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT 'google', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS site_user_sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES site_users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  const userId = await sha256("masetv-user-telegram:" + String(user.id));
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const email = "telegram-" + String(user.id) + "@telegram.local";
  await env.DB.prepare("INSERT INTO site_users (id,email,name,provider,last_login_at) VALUES (?,?,?,'telegram',datetime('now')) ON CONFLICT(email) DO UPDATE SET name=excluded.name,last_login_at=datetime('now')").bind(userId,email,name).run();
  const savedUser = await env.DB.prepare("SELECT id,name FROM site_users WHERE email=?").bind(email).first<{id:string;name:string}>();
  if (!savedUser) return json({ error: "Telegram account could not be created." }, 500);
  const tokenBytes = new Uint8Array(32); crypto.getRandomValues(tokenBytes);
  const session = [...tokenBytes].map(x=>x.toString(16).padStart(2,"0")).join("");
  await env.DB.prepare("INSERT INTO site_user_sessions (id_hash,user_id,expires_at) VALUES (?,?,datetime('now','+30 days'))").bind(await sha256(session),savedUser.id).run();
  return new Response(JSON.stringify({ user: { userId: savedUser.id, name: savedUser.name, email: "", provider: "telegram" } }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": "masetv_user_session=" + session + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000" } });
};
