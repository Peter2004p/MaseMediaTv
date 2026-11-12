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
  await db.prepare(`CREATE TABLE IF NOT EXISTS profile_unlocks (
    profile_id TEXT NOT NULL, user_id TEXT NOT NULL, token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(profile_id,user_id,token_hash)
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_profile_unlocks_expiry ON profile_unlocks(expires_at)").run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS profile_pin_attempts (
    profile_id TEXT NOT NULL, user_id TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
    window_started_at TEXT NOT NULL DEFAULT (datetime('now')), locked_until TEXT,
    PRIMARY KEY(profile_id,user_id)
  )`).run();
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
const profileShape = (row:any) => ({id:String(row.id),name:String(row.name),avatar:String(row.avatar||""),isKids:!!row.is_kids,hasPin:!!row.has_pin,createdAt:row.created_at});
export const onRequestGet: PagesFunction<ProfileEnv> = async ({request,env}) => {
  try {
    const userId=await resolveUser(request,env); if(!userId)return json({error:"Sign in to manage profiles."},401);
    await ensure(env.DB,userId);
    const rows=await env.DB.prepare("SELECT id,name,avatar,is_kids,CASE WHEN pin_hash IS NULL THEN 0 ELSE 1 END AS has_pin,created_at FROM user_profiles WHERE user_id=? ORDER BY created_at,id").bind(userId).all();
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
      if(pin)await env.DB.prepare("DELETE FROM profile_unlocks WHERE profile_id=? AND user_id=?").bind(id,userId).run();
      const row=await env.DB.prepare("SELECT id,name,avatar,is_kids,CASE WHEN pin_hash IS NULL THEN 0 ELSE 1 END AS has_pin FROM user_profiles WHERE id=? AND user_id=?").bind(id,userId).first();
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
      const attempts=await env.DB.prepare("SELECT failures,window_started_at,locked_until FROM profile_pin_attempts WHERE profile_id=? AND user_id=?").bind(id,userId).first<{failures:number;window_started_at:string;locked_until:string|null}>();
      if(attempts?.locked_until && new Date(attempts.locked_until.replace(" ","T")+"Z").getTime()>Date.now())return json({error:"Too many incorrect PIN attempts. Try again after 15 minutes."},429);
      const candidate=await sha256("masenet-profile-pin:"+id+":"+pin);
      if(candidate!==row.pin_hash){
        const sameWindow=attempts && Date.now()-new Date(attempts.window_started_at.replace(" ","T")+"Z").getTime()<15*60*1000;
        const failures=sameWindow?(attempts.failures||0)+1:1;
        const locked=failures>=5;
        await env.DB.prepare("INSERT INTO profile_pin_attempts(profile_id,user_id,failures,window_started_at,locked_until) VALUES(?,?,?,datetime('now'),CASE WHEN ?=1 THEN datetime('now','+15 minutes') ELSE NULL END) ON CONFLICT(profile_id,user_id) DO UPDATE SET failures=excluded.failures,window_started_at=CASE WHEN ?=1 THEN profile_pin_attempts.window_started_at ELSE datetime('now') END,locked_until=excluded.locked_until")
          .bind(id,userId,failures,locked?1:0,sameWindow?1:0).run();
        return json({error:locked?"Too many incorrect PIN attempts. Try again after 15 minutes.":"That profile PIN is incorrect."},locked?429:403);
      }
      await env.DB.prepare("DELETE FROM profile_pin_attempts WHERE profile_id=? AND user_id=?").bind(id,userId).run();
      const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);
      const unlockToken=[...bytes].map(v=>v.toString(16).padStart(2,"0")).join("");
      await env.DB.prepare("DELETE FROM profile_unlocks WHERE expires_at<=datetime('now') OR (profile_id=? AND user_id=?)").bind(id,userId).run();
      await env.DB.prepare("INSERT INTO profile_unlocks(profile_id,user_id,token_hash,expires_at) VALUES(?,?,?,datetime('now','+30 minutes'))")
        .bind(id,userId,await sha256(unlockToken)).run();
      return json({ok:true,unlockToken,expiresInSeconds:1800});
    }
    return json({error:"Unknown profile action."},400);
  } catch { return json({error:"Profile update failed. Please retry."},503); }
};
