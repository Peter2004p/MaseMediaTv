import { Env, json, sha256 } from "../_shared";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: { code?: string };
  try { body = await request.json() as { code?: string }; }
  catch { return json({ error: "The sign-in response was invalid. Please try again." }, 400); }
  const code = String(body.code || "");
  if (!/^[a-f0-9]{64}$/.test(code)) return json({ error: "The sign-in link is invalid or expired. Please try again." }, 400);

  await env.DB.prepare("CREATE TABLE IF NOT EXISTS native_auth_codes (code_hash TEXT PRIMARY KEY, session_token TEXT NOT NULL, cookie_name TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  const row = await env.DB.prepare("SELECT session_token,cookie_name FROM native_auth_codes WHERE code_hash=? AND expires_at > datetime('now')")
    .bind(await sha256(code)).first<{ session_token: string; cookie_name: string }>();
  if (!row || !["masetv_session", "masetv_user_session"].includes(row.cookie_name)) {
    return json({ error: "The sign-in link has expired. Please return to MaseNet and try again." }, 401);
  }
  await env.DB.prepare("DELETE FROM native_auth_codes WHERE code_hash=?").bind(await sha256(code)).run();
  const maxAge = row.cookie_name === "masetv_session" ? 604800 : 2592000;
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Set-Cookie": row.cookie_name + "=" + row.session_token + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + maxAge
  });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
