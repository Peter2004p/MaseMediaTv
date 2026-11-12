import {Env,json,cookie,sha256,currentAdmin} from "./auth/_shared";
const allowed=["off","auto","en","zh","ko","ja","es","fr","ar","hi","pt"];
async function resolveUser(request:Request,env:Env):Promise<string|null>{
 const admin=await currentAdmin(request,env);if(admin)return "admin:"+admin.id;
 const token=cookie(request,"masetv_user_session");if(!token)return null;
 const row=await env.DB.prepare("SELECT u.id FROM site_user_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>datetime('now')").bind(await sha256(token)).first<{id:string}>();
 return row?.id||null;
}
async function ensure(db:D1Database,user:string){
 await db.prepare("CREATE TABLE IF NOT EXISTS user_player_preferences(user_id TEXT PRIMARY KEY,subtitle_language TEXT NOT NULL DEFAULT 'off',audio_language TEXT NOT NULL DEFAULT 'auto',updated_at TEXT NOT NULL DEFAULT(datetime('now')))").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS user_profiles(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,avatar TEXT NOT NULL DEFAULT '',is_kids INTEGER NOT NULL DEFAULT 0,pin_hash TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(user_id,name))").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS profile_preferences(profile_id TEXT PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,payload TEXT NOT NULL DEFAULT '{}',updated_at TEXT NOT NULL DEFAULT(datetime('now')))").run();
 const defaultId=(await sha256("masenet-profile-default:"+user)).slice(0,32);
 await db.prepare("INSERT OR IGNORE INTO user_profiles(id,user_id,name,avatar,is_kids) VALUES(?,?,'Main profile','',0)").bind(defaultId,user).run();
 const legacy=await db.prepare("SELECT subtitle_language,audio_language FROM user_player_preferences WHERE user_id=?").bind(user).first<{subtitle_language:string;audio_language:string}>();
 if(legacy)await db.prepare("INSERT OR IGNORE INTO profile_preferences(profile_id,payload) VALUES(?,?)").bind(defaultId,JSON.stringify({subtitleLanguage:legacy.subtitle_language,audioLanguage:legacy.audio_language})).run();
 return defaultId;
}
export const onRequestGet:PagesFunction<Env>=async({request,env})=>{
 try{
  const user=await resolveUser(request,env);if(!user)return json({error:"Sign in to sync player preferences across devices."},401);
  const defaultId=await ensure(env.DB,user),profileId=new URL(request.url).searchParams.get("profileId")||defaultId;
  const owned=await env.DB.prepare("SELECT id FROM user_profiles WHERE id=? AND user_id=?").bind(profileId,user).first();
  if(!owned)return json({error:"Selected profile does not belong to this account."},403);
  const row=await env.DB.prepare("SELECT payload,updated_at FROM profile_preferences WHERE profile_id=?").bind(profileId).first<{payload:string;updated_at:string}>();
  let prefs:any={};try{prefs=JSON.parse(row?.payload||"{}")}catch{}
  return json({preferences:{subtitleLanguage:allowed.includes(prefs.subtitleLanguage)?prefs.subtitleLanguage:"off",audioLanguage:allowed.includes(prefs.audioLanguage)?prefs.audioLanguage:"auto"},profileId,updatedAt:row?.updated_at||null});
 }catch{return json({error:"Player preferences could not be loaded."},503)}
};
export const onRequestPost:PagesFunction<Env>=async({request,env})=>{
 try{
  const user=await resolveUser(request,env);if(!user)return json({error:"Sign in to sync player preferences across devices."},401);
  const raw=await request.text();if(raw.length>2000)return json({error:"Request too large."},413);
  let body:any;try{body=JSON.parse(raw)}catch{return json({error:"Invalid preferences."},400)}
  const subtitle=String(body.subtitleLanguage||"off"),audio=String(body.audioLanguage||"auto");
  if(!allowed.includes(subtitle)||!allowed.includes(audio))return json({error:"Unsupported language preference."},400);
  const defaultId=await ensure(env.DB,user),profileId=String(body.profileId||defaultId);
  const owned=await env.DB.prepare("SELECT id FROM user_profiles WHERE id=? AND user_id=?").bind(profileId,user).first();
  if(!owned)return json({error:"Selected profile does not belong to this account."},403);
  await env.DB.prepare("INSERT INTO profile_preferences(profile_id,payload,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(profile_id) DO UPDATE SET payload=excluded.payload,updated_at=datetime('now')").bind(profileId,JSON.stringify({subtitleLanguage:subtitle,audioLanguage:audio})).run();
  return json({ok:true,profileId,preferences:{subtitleLanguage:subtitle,audioLanguage:audio}});
 }catch{return json({error:"Player preferences could not be saved."},503)}
};
