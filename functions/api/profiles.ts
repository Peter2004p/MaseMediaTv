import { Env, json, cookie, sha256, currentAdmin } from "./auth/_shared";

type ProfileEnv = Env;
async function resolveUser(request: Request, env: ProfileEnv): Promise<string | null> {
  const admin = await currentAdmin(request, env);
  if (admin) return "admin:" + admin.id;
  const token = cookie(request, "masetv_user_session");
  if (!token) return null;
  const user = await env.DB.prepare("SELECT u.id FROM site_user_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>datetime('now')")
    .bind(await sha256(token)).first<{id:string}>();
  return user?.id || null;
}
async function ensure(db: D1Database, userId: string) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_profiles (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '',
    is_kids INTEGER NOT NULL DEFAULT 0, pin_hash TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id,name)
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_user_profiles_owner ON user_profiles(user_id,created_at)").run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS profile_library_state (
    profile_id TEXT PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
    payload TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS profile_preferences (
    profile_id TEXT PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
    payload TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  const defaultId = (await sha256("masenet-profile-default:" + userId)).slice(0,32);
  await db.prepare("INSERT OR IGNORE INTO user_profiles(id,user_id,name,avatar,is_kids) VALUES(?,?,'Main profile','',0)").bind(defaultId,userId).run();
  // One-time, non-destructive migration: copy the legacy account library into Main profile.
  const legacy = await db.prepare("SELECT payload FROM user_library_state WHERE user_id=?").bind(userId).first<{payload:string}>();
  if (legacy?.payload) {
    await db.prepare("INSERT OR IGNORE INTO profile_library_state(profile_id,payload) VALUES(?,?)").bind(defaultId,legacy.payload).run();
  }
}
const profileShape = (row:any) => ({id:String(row.id),name:String(row.name),avatar:String(row.avatar||""),isKids:!!row.is_kids,createdAt:row.created_at});
export const onRequestGet: PagesFunction<ProfileEnv> = async ({request,env}) => {
  try {
    const userId=await resolveUser(request,env); if(!userId)return json({error:"Sign in to manage profiles."},401);
    await ensure(env.DB,userId);
    const rows=await env.DB.prepare("SELECT id,name,avatar,is_kids,created_at FROM user_profiles WHERE user_id=? ORDER BY created_at,id").bind(userId).all();
    return json({profiles:(rows.results||[]).map(profileShape),maxProfiles:6});
  } catch { return json({error:"Profiles could not be loaded."},503); }
};
export const onRequestPost: PagesFunction<ProfileEnv> = async ({request,env}) => {
  try {
    const userId=await resolveUser(request,env); if(!userId)return json({error:"Sign in to manage profiles."},401);
    const raw=await request.text(); if(raw.length>5000)return json({error:"Request too large."},413);
    const body=JSON.parse(raw||"{}") as {action?:string;id?:string;name?:string;avatar?:string;isKids?:boolean;pin?:string};
    await ensure(env.DB,userId);
    if(body.action==="create"){
      const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM user_profiles WHERE user_id=?").bind(userId).first<{n:number}>();
      if((count?.n||0)>=6)return json({error:"You can create up to 6 profiles."},409);
      const name=String(body.name||"").trim().replace(/\s+/g," ").slice(0,24);
      if(name.length<1)return json({error:"Enter a profile name."},400);
      const id=crypto.randomUUID().replace(/-/g,"");
      const pin=String(body.pin||"").trim();
      if(pin && !/^\d{4,6}$/.test(pin))return json({error:"Profile PIN must be 4 to 6 digits."},400);
      const pinHash=pin?await sha256("masenet-profile-pin:"+id+":"+pin):null;
      try { await env.DB.prepare("INSERT INTO user_profiles(id,user_id,name,avatar,is_kids,pin_hash) VALUES(?,?,?,?,?,?)").bind(id,userId,name,String(body.avatar||"").slice(0,300),body.isKids?1:0,pinHash).run(); }
      catch { return json({error:"A profile with that name already exists."},409); }
      return json({ok:true,profile:{id,name,avatar:String(body.avatar||""),isKids:!!body.isKids}});
    }
    if(body.action==="update"){
      const id=String(body.id||""); const name=String(body.name||"").trim().replace(/\s+/g," ").slice(0,24);
      if(!id||!name)return json({error:"Profile and name are required."},400);
      const pin=String(body.pin||"").trim();
      if(pin && !/^\d{4,6}$/.test(pin))return json({error:"Profile PIN must be 4 to 6 digits."},400);
      const pinHash=pin?await sha256("masenet-profile-pin:"+id+":"+pin):null;
      try {
        await env.DB.prepare("UPDATE user_profiles SET name=?,avatar=?,is_kids=?,pin_hash=CASE WHEN ?=1 THEN ? ELSE pin_hash END,updated_at=datetime('now') WHERE id=? AND user_id=?")
          .bind(name,String(body.avatar||"").slice(0,300),body.isKids?1:0,pin?1:0,pinHash,id,userId).run();
      } catch { return json({error:"A profile with that name already exists."},409); }
      const row=await env.DB.prepare("SELECT id,name,avatar,is_kids FROM user_profiles WHERE id=? AND user_id=?").bind(id,userId).first();
      if(!row)return json({error:"Profile not found."},404);
      return json({ok:true,profile:profileShape(row)});
    }
    if(body.action==="delete"){
      const id=String(body.id||"");
      const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM user_profiles WHERE user_id=?").bind(userId).first<{n:number}>();
      if((count?.n||0)<=1)return json({error:"Keep at least one profile on your account."},409);
      const result=await env.DB.prepare("DELETE FROM user_profiles WHERE id=? AND user_id=?").bind(id,userId).run();
      if(!result.meta.changes)return json({error:"Profile not found."},404);
      return json({ok:true});
    }
    if(body.action==="verify-pin"){
      const id=String(body.id||""),pin=String(body.pin||"");
      const row=await env.DB.prepare("SELECT pin_hash FROM user_profiles WHERE id=? AND user_id=?").bind(id,userId).first<{pin_hash:string|null}>();
      if(!row)return json({error:"Profile not found."},404);
      if(!row.pin_hash)return json({ok:true});
      const candidate=await sha256("masenet-profile-pin:"+id+":"+pin);
      if(candidate!==row.pin_hash)return json({error:"That profile PIN is incorrect."},403);
      return json({ok:true});
    }
    return json({error:"Unknown profile action."},400);
  } catch { return json({error:"Profile update failed. Please retry."},503); }
};
