import { Env, json, cookie, sha256, currentAdmin, requireAdmin } from "./auth/_shared";

type PremiereEnv = Env;
const validId=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,180}$/.test(v);
async function userId(request:Request,env:PremiereEnv):Promise<string|null>{
 const admin=await currentAdmin(request,env);if(admin)return "admin:"+admin.id;
 const token=cookie(request,"masetv_user_session");if(!token)return null;
 const row=await env.DB.prepare("SELECT u.id FROM site_user_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>datetime('now')").bind(await sha256(token)).first<{id:string}>();
 return row?.id||null;
}
async function ensure(db:D1Database){
 await db.prepare(`CREATE TABLE IF NOT EXISTS title_premieres(
 id TEXT PRIMARY KEY,title_id TEXT NOT NULL,title_name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
 premiere_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled','published')),
 created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now'))
 )`).run();
 const columns=await db.prepare("PRAGMA table_info(title_premieres)").all<{name:string}>();
 const names=new Set((columns.results||[]).map(column=>column.name));
 if(!names.has("media_url"))await db.prepare("ALTER TABLE title_premieres ADD COLUMN media_url TEXT NOT NULL DEFAULT ''").run();
 if(!names.has("media_type"))await db.prepare("ALTER TABLE title_premieres ADD COLUMN media_type TEXT NOT NULL DEFAULT ''").run();
 await db.prepare("CREATE INDEX IF NOT EXISTS idx_title_premieres_at ON title_premieres(status,premiere_at)").run();
 await db.prepare(`CREATE TABLE IF NOT EXISTS premiere_reminders(
 premiere_id TEXT NOT NULL,user_id TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),
 PRIMARY KEY(premiere_id,user_id)
 )`).run();
}
export const onRequestGet:PagesFunction<PremiereEnv>=async({request,env})=>{
 try{
  await ensure(env.DB);const uid=await userId(request,env);
  const rows=await env.DB.prepare("SELECT p.id,p.title_id AS titleId,p.title_name AS titleName,p.description,p.premiere_at AS premiereAt,p.media_url AS mediaUrl,p.media_type AS mediaType,p.status,COUNT(r.user_id) AS reminderCount FROM title_premieres p LEFT JOIN premiere_reminders r ON r.premiere_id=p.id WHERE p.status='scheduled' AND p.premiere_at>=datetime('now','-1 day') GROUP BY p.id ORDER BY p.premiere_at ASC LIMIT 30").all<any>();
  let reminders:string[]=[];
  if(uid){const mine=await env.DB.prepare("SELECT premiere_id FROM premiere_reminders WHERE user_id=?").bind(uid).all<{premiere_id:string}>();reminders=(mine.results||[]).map(x=>x.premiere_id);}
  return json({premieres:rows.results||[],reminders});
 }catch{return json({error:"Premiere schedule is temporarily unavailable."},503)}
};
export const onRequestPost:PagesFunction<PremiereEnv>=async({request,env})=>{
 try{
  await ensure(env.DB);const raw=await request.text();if(raw.length>5000)return json({error:"Request too large."},413);
  let body:Record<string,unknown>;try{body=JSON.parse(raw)}catch{return json({error:"Invalid JSON."},400)}
  if(body.action==="remind"){
   const uid=await userId(request,env);if(!uid)return json({error:"Sign in to receive premiere reminders."},401);
   if(!validId(body.premiereId))return json({error:"Invalid premiere."},400);
   const p=await env.DB.prepare("SELECT id FROM title_premieres WHERE id=? AND status='scheduled'").bind(body.premiereId).first();
   if(!p)return json({error:"Premiere not found."},404);
   if(body.enabled===false)await env.DB.prepare("DELETE FROM premiere_reminders WHERE premiere_id=? AND user_id=?").bind(body.premiereId,uid).run();
   else await env.DB.prepare("INSERT OR IGNORE INTO premiere_reminders(premiere_id,user_id) VALUES(?,?)").bind(body.premiereId,uid).run();
   return json({ok:true,enabled:body.enabled!==false});
  }
  const gate=await requireAdmin(request,env);if(gate.response)return gate.response;
  if(body.action==="delete"){
   if(!validId(body.id))return json({error:"Invalid premiere ID."},400);
   await env.DB.prepare("UPDATE title_premieres SET status='cancelled',updated_at=datetime('now') WHERE id=?").bind(body.id).run();
   return json({ok:true});
  }
  if(body.action!=="schedule"||!validId(body.titleId)||typeof body.titleName!=="string"||!body.titleName.trim()||typeof body.premiereAt!=="string"||Number.isNaN(Date.parse(body.premiereAt)))return json({error:"Provide a title, valid premiere date and time, and schedule action."},400);
  const date=new Date(body.premiereAt);if(date.getTime()<Date.now()-60000)return json({error:"Premiere time must be in the future."},400);
  const title=await env.DB.prepare("SELECT id FROM titles WHERE id=?").bind(body.titleId).first();if(!title)return json({error:"Title not found in the catalogue."},404);
  let mediaUrl="",mediaType="";
  if(body.mediaUrl!==undefined&&body.mediaUrl!==""){
   if(typeof body.mediaUrl!=="string"||typeof body.mediaType!=="string")return json({error:"Invalid premiere media."},400);
   const allowedTypes=["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","video/quicktime"];
   if(!allowedTypes.includes(body.mediaType))return json({error:"Premiere media must be a supported image or video."},415);
   let media:URL;try{media=new URL(body.mediaUrl,request.url)}catch{return json({error:"Invalid premiere media URL."},400)}
   if(media.origin!==new URL(request.url).origin||media.pathname!=="/api/media/file")return json({error:"Premiere media must be uploaded to MaseNet Gallery storage."},400);
   mediaUrl=media.toString();mediaType=body.mediaType;
  }
  const id=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO title_premieres(id,title_id,title_name,description,premiere_at,media_url,media_type) VALUES(?,?,?,?,?,?,?)").bind(id,body.titleId,body.titleName.trim().slice(0,180),typeof body.description==="string"?body.description.trim().slice(0,1000):"",date.toISOString().replace("T"," ").replace("Z",""),mediaUrl,mediaType).run();
  return json({ok:true,id});
 }catch{return json({error:"Premiere update failed. Please try again."},503)}
};
