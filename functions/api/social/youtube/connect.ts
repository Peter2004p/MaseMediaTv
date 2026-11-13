import { Env, json, currentAdmin } from "../../auth/_shared";

type SocialEnv = Env & { YOUTUBE_CLIENT_ID?: string; YOUTUBE_CLIENT_SECRET?: string };
const randomState = () => { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return [...bytes].map(x => x.toString(16).padStart(2,"0")).join(""); };

export const onRequestGet: PagesFunction<SocialEnv> = async ({ request, env }) => {
  const admin = await currentAdmin(request, env);
  if (!admin || admin.role !== "owner") return json({ error: "Only the MaseNet owner can connect social accounts." }, 403);
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) return json({ error: "YouTube OAuth is not configured in Cloudflare yet." }, 503);
  const state = randomState();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS social_oauth_states (state_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL, provider TEXT NOT NULL, expires_at TEXT NOT NULL)`).run();
  await env.DB.prepare("DELETE FROM social_oauth_states WHERE expires_at <= datetime('now')").run();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  const stateHash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2,"0")).join("");
  await env.DB.prepare("INSERT INTO social_oauth_states(state_hash,admin_id,provider,expires_at) VALUES(?,?,'youtube',datetime('now','+10 minutes'))").bind(stateHash, admin.id).run();
  const redirectUri = new URL("/api/social/youtube/callback", urlOrigin(request)).toString();
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.searchParams.set("client_id", env.YOUTUBE_CLIENT_ID);
  target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl");
  target.searchParams.set("access_type", "offline");
  target.searchParams.set("prompt", "consent");
  target.searchParams.set("include_granted_scopes", "true");
  target.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { "Location": target.toString(), "Set-Cookie": "masenet_youtube_oauth_state="+state+"; HttpOnly; Secure; SameSite=Lax; Path=/api/social/youtube; Max-Age=600", "Cache-Control": "no-store" } });
};
function urlOrigin(request: Request) { return new URL(request.url).origin; }
