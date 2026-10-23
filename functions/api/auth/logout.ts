import { Env, cookie, sha256 } from "./_shared";
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const adminToken = cookie(request, "masetv_session");
  const userToken = cookie(request, "masetv_user_session");
  if (adminToken) await env.DB.prepare("DELETE FROM admin_sessions WHERE id_hash = ?").bind(await sha256(adminToken)).run();
  if (userToken) { try { await env.DB.prepare("DELETE FROM site_user_sessions WHERE id_hash = ?").bind(await sha256(userToken)).run(); } catch {} }
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", "masetv_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  headers.append("Set-Cookie", "masetv_user_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return new Response(JSON.stringify({ ok: true }), { headers });
};