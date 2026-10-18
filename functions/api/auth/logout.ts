import { Env, cookie, json, sha256 } from "./_shared";
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const token = cookie(request, "masetv_session");
  if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE id_hash = ?").bind(await sha256(token)).run();
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": "masetv_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" } });
};
