import { Env, currentAdmin, json, cookie, sha256 } from "./_shared";
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const admin = await currentAdmin(request, env);
  if (admin) return json({ user: { userId: admin.id, email: admin.email, provider: "google", role: admin.role } });
  const token = cookie(request, "masetv_user_session");
  if (!token) return json({ user: null });
  try {
    const user = await env.DB.prepare("SELECT u.id,u.email,u.name,u.picture,u.provider FROM site_user_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at > datetime('now')").bind(await sha256(token)).first<{id:string;email:string;name:string;picture:string;provider:string}>();
    return json({ user: user ? { userId:user.id,email:user.email,name:user.name,picture:user.picture,provider:user.provider } : null });
  } catch { return json({ user: null }); }
};