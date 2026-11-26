import { json } from "../auth/_shared";

interface Env { DB: D1Database; }
const sha256 = async (value:string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((x)=>x.toString(16).padStart(2,"0")).join("");
};

// The ingest webhook can create the asset registry before D1 migrations are applied.
// Keep the delivery-token table available in that recovery state too.
const ensureDeliveryTokenTable = async (db:D1Database) => {
  await db.prepare(`CREATE TABLE IF NOT EXISTS telegram_media_delivery_tokens (
    token_hash TEXT PRIMARY KEY,
    media_asset_id TEXT NOT NULL REFERENCES telegram_media_assets(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_telegram_media_delivery_expiry ON telegram_media_delivery_tokens(expires_at)").run();
};

export const onRequestPost: PagesFunction<Env> = async ({request,env}) => {
  const origin = request.headers.get("Origin");
  if (origin !== new URL(request.url).origin) return json({ok:false,error:"Same-origin requests are required."},403);
  let body: {assetId?:string};
  try { body = await request.json() as {assetId?:string}; } catch { return json({ok:false,error:"Invalid request."},400); }
  const assetId = String(body.assetId || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) return json({ok:false,error:"Invalid media selection."},400);
  try {
    await ensureDeliveryTokenTable(env.DB);
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
  } catch (error) {
    console.error("MaseNet download token creation failed:",error instanceof Error?error.message:"unknown error");
    return json({ok:false,error:"MaseNet could not prepare this download. Please try again shortly."},503);
  }
};
