import { json, sha256 } from "../_shared";
interface EmailEnv { DB: D1Database; }
const validEmail=(value:string)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)&&value.length<=254;
const randomToken=()=>{const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);return [...bytes].map(value=>value.toString(16).padStart(2,"0")).join("");};
export const onRequestPost:PagesFunction<EmailEnv>=async({request,env})=>{
 const body=await request.json().catch(()=>({})) as {email?:string;code?:string};
 const email=String(body.email||"").trim().toLowerCase(),code=String(body.code||"").trim();
 if(!validEmail(email)||!/^\d{6}$/.test(code))return json({error:"Enter your email address and the six-digit code."},400);
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS email_login_codes(email TEXT PRIMARY KEY,code_hash TEXT NOT NULL,salt TEXT NOT NULL,expires_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
 const record=await env.DB.prepare("SELECT code_hash,salt,attempts FROM email_login_codes WHERE email=? AND expires_at>datetime('now')").bind(email).first<{code_hash:string;salt:string;attempts:number}>();
 if(!record)return json({error:"That code has expired or was not found. Request a new one."},400);
 if(record.attempts>=5){await env.DB.prepare("DELETE FROM email_login_codes WHERE email=?").bind(email).run();return json({error:"Too many incorrect attempts. Request a new code."},429);}
 const submitted=await sha256(email+":"+code+":"+record.salt);
 if(submitted!==record.code_hash){await env.DB.prepare("UPDATE email_login_codes SET attempts=attempts+1 WHERE email=?").bind(email).run();return json({error:"That code is incorrect. Please check your email and try again."},401);}
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS site_users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL DEFAULT '',picture TEXT NOT NULL DEFAULT '',provider TEXT NOT NULL DEFAULT 'google',created_at TEXT NOT NULL DEFAULT (datetime('now')),last_login_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS site_user_sessions(id_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES site_users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
 const userId=await sha256("masetv-user-email:"+email);
 await env.DB.prepare("INSERT INTO site_users(id,email,name,provider,last_login_at) VALUES(?,?,?,'email',datetime('now')) ON CONFLICT(email) DO UPDATE SET last_login_at=datetime('now'),provider='email'").bind(userId,email,"").run();
 const user=await env.DB.prepare("SELECT id,email,name,picture FROM site_users WHERE email=?").bind(email).first<{id:string;email:string;name:string;picture:string}>();
 if(!user)return json({error:"Your MaseNet account could not be created."},500);
 const token=randomToken();
 await env.DB.prepare("INSERT INTO site_user_sessions(id_hash,user_id,expires_at) VALUES(?,?,datetime('now','+30 days'))").bind(await sha256(token),user.id).run();
 await env.DB.prepare("DELETE FROM email_login_codes WHERE email=?").bind(email).run();
 return new Response(JSON.stringify({user:{userId:user.id,email:user.email,name:user.name,picture:user.picture,provider:"email"}}),{headers:{"Content-Type":"application/json","Cache-Control":"no-store","Set-Cookie":"masetv_user_session="+token+"; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000"}});
};