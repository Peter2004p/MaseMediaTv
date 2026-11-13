import { Env, json, currentAdmin } from "../../auth/_shared";

type SocialEnv = Env & { YOUTUBE_CLIENT_ID?: string; YOUTUBE_CLIENT_SECRET?: string; YOUTUBE_TOKEN_ENCRYPTION_KEY?: string };
const hash = async (value: string) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2,"0")).join("");
};
export const onRequestGet: PagesFunction<SocialEnv> = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)masenet_youtube_oauth_state=([^;]+)/);
  const cookieState = match ? decodeURIComponent(match[1]) : "";
  const fail = (reason: string) => Response.redirect(new URL("/#/admin", url.origin), 302);
  if (url.searchParams.has("error")) return fail("Google authorization was cancelled or denied.");
  if (!code || !state || !cookieState || state !== cookieState) return fail("The YouTube connection session expired. Start again from MaseNet.");
  const admin = await currentAdmin(request, env);
  if (!admin || admin.role !== "owner") return fail("Your MaseNet owner session expired. Sign in again.");
  const stateRow = await env.DB.prepare("SELECT admin_id FROM social_oauth_states WHERE state_hash=? AND provider='youtube' AND expires_at>datetime('now')").bind(await hash(state)).first<{admin_id:string}>();
  if (!stateRow || stateRow.admin_id !== admin.id) return fail("The YouTube authorization could not be verified. Start again.");
  await env.DB.prepare("DELETE FROM social_oauth_states WHERE state_hash=?").bind(await hash(state)).run();
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) return fail("YouTube OAuth credentials are missing in Cloudflare.");
  const redirectUri = url.origin + "/api/social/youtube/callback";
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.YOUTUBE_CLIENT_ID, client_secret: env.YOUTUBE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" })
  });
  if (!tokenResponse.ok) return fail("Google could not exchange the authorization code. Check the OAuth redirect URI.");
  const tokens = await tokenResponse.json() as { access_token?:string; refresh_token?:string; expires_in?:number; scope?:string };
  if (!tokens.access_token || !tokens.refresh_token) return fail("Google did not return a refresh token. Remove MaseNet access from your Google account and connect again.");
  const channelResponse = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: "Bearer "+tokens.access_token } });
  if (!channelResponse.ok) return fail("Google authorized the account, but MaseNet could not read its YouTube channel.");
  const channelData = await channelResponse.json() as { items?:Array<{id?:string;snippet?:{title?:string;customUrl?:string}} > };
  const channel = channelData.items?.[0];
  if (!channel?.id) return fail("No YouTube channel was found for the selected Google account.");
  // Tokens are never stored in plaintext. Configure a 32-byte base64 AES key as YOUTUBE_TOKEN_ENCRYPTION_KEY.
  const encryptionKey = env.YOUTUBE_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) return fail("Cloudflare is missing YOUTUBE_TOKEN_ENCRYPTION_KEY. No token was saved.");
  let rawKey: Uint8Array;
  try { rawKey = Uint8Array.from(atob(encryptionKey), c => c.charCodeAt(0)); } catch { return fail("YOUTUBE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key."); }
  if (rawKey.length !== 32) return fail("YOUTUBE_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  const key = await crypto.subtle.importKey("raw", rawKey.slice().buffer as ArrayBuffer, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name:"AES-GCM", iv: iv.slice().buffer as ArrayBuffer }, key, new TextEncoder().encode(tokens.refresh_token));
  const packed = btoa(String.fromCharCode(...iv,...new Uint8Array(encrypted)));
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS social_connections (
    provider TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_title TEXT NOT NULL,
    encrypted_refresh_token TEXT NOT NULL, connected_by TEXT NOT NULL,
    connected_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare("INSERT INTO social_connections(provider,channel_id,channel_title,encrypted_refresh_token,connected_by) VALUES('youtube',?,?,?,?) ON CONFLICT(provider) DO UPDATE SET channel_id=excluded.channel_id,channel_title=excluded.channel_title,encrypted_refresh_token=excluded.encrypted_refresh_token,connected_by=excluded.connected_by,updated_at=datetime('now')")
    .bind(channel.id, channel.snippet?.title || "YouTube channel", packed, admin.id).run();
  const headers = new Headers({ Location: new URL("/#/admin", url.origin).toString(), "Cache-Control":"no-store" });
  headers.append("Set-Cookie","masenet_youtube_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/social/youtube; Max-Age=0");
  return new Response(null,{status:302,headers});
};
