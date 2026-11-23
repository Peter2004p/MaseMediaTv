import { json } from "../auth/_shared";

interface Env { DB: D1Database; }
const sha256 = async (value:string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((x)=>x.toString(16).padStart(2,"0")).join("");
};
export const onRequestPost: PagesFunction<Env> = async ({request,env}) => {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ok:false,error:"Cross-origin requests are not accepted."},403);
  let body: {assetId?:string};
  try { body = await request.json() as {assetId?:string}; } catch { return json({ok:false,error:"Invalid request."},400); }
  const assetId = String(body.assetId || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) return json({ok:false,error:"Invalid media selection."},400);
  const asset = await env.DB.prepare(
    "SELECT id FROM telegram_media_assets WHERE id=? AND status='published' AND rights_confirmed=1"
  ).bind(assetId).first<{id:string}>();
  if (!asset) return json({ok:false,error:"This media is not currently available."},404);
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = [...bytes].map((x)=>x.toString(16).padStart(2,"0")).join("");
  const tokenHash = await sha256(token);
  await env.DB.prepare("DELETE FROM telegram_media_delivery_tokens WHERE expires_at <= datetime('now') OR used_at IS NOT NULL").run();
  await env.DB.prepare(
    "INSERT INTO telegram_media_delivery_tokens(token_hash,media_asset_id,expires_at) VALUES(?,?,datetime('now','+10 minutes'))"
  ).bind(tokenHash,assetId).run();
  return json({ok:true,telegramUrl:"https://t.me/MaseTv_Bot?start=dl_"+token,expiresInSeconds:600});
};
