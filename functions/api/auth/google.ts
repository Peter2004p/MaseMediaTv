import { Env, json, sha256 } from "./_shared";
type AuthEnv = Env & { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string };
const randomHex = () => { const b = new Uint8Array(24); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2,"0")).join(""); };
export const onRequestGet: PagesFunction<AuthEnv> = async ({ request, env }) => {
  const url = new URL(request.url);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: "Google sign-in needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET configured in Cloudflare." }, 503);
  const redirectUri = url.origin + "/api/auth/google/callback";
  if (url.pathname.endsWith("/callback")) {
    const code = url.searchParams.get("code"), state = url.searchParams.get("state");
    const match = request.headers.get("Cookie")?.match(/(?:^|;\s*)masetv_oauth_state=([^;]+)/);
    if (!code || !state || !match || decodeURIComponent(match[1]) !== state) return json({ error: "Sign-in state expired. Please try again." }, 400);
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" }) });
    if (!tokenRes.ok) return json({ error: "Google sign-in could not be completed." }, 401);
    const tokenData = await tokenRes.json() as { access_token?: string };
    if (!tokenData.access_token) return json({ error: "Google did not provide a sign-in token." }, 401);
    const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: "Bearer " + tokenData.access_token } });
    if (!profileRes.ok) return json({ error: "Google account could not be verified." }, 401);
    const profile = await profileRes.json() as { email?: string; verified_email?: boolean };
    const email = (profile.email || "").toLowerCase();
    if (!profile.verified_email || email !== (env.ADMIN_EMAIL || "pb5089780@gmail.com").toLowerCase()) return json({ error: "This Google account is not authorized as MaseTv admin." }, 403);
    const adminId = await sha256("masetv-google-admin:" + email);
    await env.DB.prepare("INSERT INTO admins (id,email) VALUES (?,?) ON CONFLICT(email) DO NOTHING").bind(adminId, email).run();
    const admin = await env.DB.prepare("SELECT id FROM admins WHERE email=?").bind(email).first<{id:string}>();
    if (!admin) return json({ error: "Admin session could not be created." }, 500);
    const session = randomHex(), sessionHash = await sha256(session);
    await env.DB.prepare("INSERT INTO admin_sessions (id_hash,admin_id,expires_at) VALUES (?,?,datetime('now','+7 days'))").bind(sessionHash, admin.id).run();
    return new Response(null, { status: 302, headers: { "Location": url.origin + "/#/home", "Set-Cookie": "masetv_session=" + session + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800" } });
  }
  const state = randomHex();
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.searchParams.set("client_id", env.GOOGLE_CLIENT_ID); target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("response_type", "code"); target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", state); target.searchParams.set("prompt", "select_account");
  return new Response(null, { status: 302, headers: { "Location": target.toString(), "Set-Cookie": "masetv_oauth_state=" + state + "; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google; Max-Age=600" } });
};
