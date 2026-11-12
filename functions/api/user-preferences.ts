import {Env,json,cookie,sha256,currentAdmin} from "./auth/_shared";
type Prefs={subtitleLanguage:string;audioLanguage:string};
const allowed=["off","auto","en","zh","ko","ja","es","fr","ar","hi","pt"];
async function resolveUser(request:Request,env:Env):Promise<string|null>{
 const admin=await currentAdmin(request,env);if(admin)return "admin:"+admin.id;
 const token=cookie(request,"masetv_user_session");if(!token)return null;
 const row=await env.DB.prepare("SELECT u.id FROM site_user_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>datetime('now')").bind(await sha256(token)).first<{id:string}>();
 return row?.id||null;
}
async function ensure(db:D1Database){await db.prepare("CREATE TABLE IF NOT EXISTS user_player_preferences(user_id TEXT PRIMARY KEY,subtitle_language TEXT NOT NULL DEFAULT 'off',audio_language TEXT NOT NULL DEFAULT 'auto',updated_at TEXT NOT NULL DEFAULT(datetime('now')))").run();}
export const onRequestGet:PagesFunction<Env>=async({request,env})=>{
 try{const user=await resolveUser(request,env);if(!user)return json({error:"Sign in to sync player preferences across devices."},401);await ensure(env.DB);const row=await env.DB.prepare("SELECT subtitle_language,audio_language,updated_at FROM user_player_preferences WHERE user_id=?").bind(user).first<{subtitle_language:string;audio_language:string;updated_at:string}>();return json({preferences:{subtitleLanguage:row?.subtitle_language||"off",audioLanguage:row?.audio_language||"auto"},updatedAt:row?.updated_at||null});}catch{return json({error:"Player preferences could not be loaded."},503)}
};
export const onRequestPost:PagesFunction<Env>=async({request,env})=>{
 try{const user=await resolveUser(request,env);if(!user)return json({error:"Sign in to sync player preferences across devices."},401);const raw=await request.text();if(raw.length>2000)return json({error:"Request too large."},413);let body:any;try{body=JSON.parse(raw)}catch{return json({error:"Invalid preferences."},400)}const subtitle=String(body.subtitleLanguage||"off"),audio=String(body.audioLanguage||"auto");if(!allowed.includes(subtitle)||!allowed.includes(audio))return json({error:"Unsupported language preference."},400);await ensure(env.DB);await env.DB.prepare("INSERT INTO user_player_preferences(user_id,subtitle_language,audio_language,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET subtitle_language=excluded.subtitle_language,audio_language=excluded.audio_language,updated_at=datetime('now')").bind(user,subtitle,audio).run();return json({ok:true,preferences:{subtitleLanguage:subtitle,audioLanguage:audio}});}catch{return json({error:"Player preferences could not be saved."},503)}
};