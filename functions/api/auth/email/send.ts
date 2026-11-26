import { json, sha256 } from "../_shared";
interface EmailEnv { DB: D1Database; RESEND_API_KEY?: string; EMAIL_FROM?: string; }
const validEmail=(value:string)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)&&value.length<=254;
const randomHex=(length=16)=>{const bytes=new Uint8Array(length);crypto.getRandomValues(bytes);return [...bytes].map(value=>value.toString(16).padStart(2,"0")).join("");};
export const onRequestPost:PagesFunction<EmailEnv>=async({request,env})=>{
 const body=await request.json().catch(()=>({})) as {email?:string};
 const email=String(body.email||"").trim().toLowerCase();
 if(!validEmail(email))return json({error:"Enter a valid email address."},400);
 if(!env.RESEND_API_KEY||!env.EMAIL_FROM)return json({error:"Email sign-in is not configured yet. The MaseNet owner must add the email provider key and a verified sender address in Cloudflare."},503);
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS email_login_codes(email TEXT PRIMARY KEY,code_hash TEXT NOT NULL,salt TEXT NOT NULL,expires_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
 const existing=await env.DB.prepare("SELECT created_at FROM email_login_codes WHERE email=?").bind(email).first<{created_at:string}>();
 if(existing){const age=await env.DB.prepare("SELECT (unixepoch('now')-unixepoch(?)) AS seconds").bind(existing.created_at).first<{seconds:number}>();if(Number(age?.seconds??9999)<60)return json({error:"Please wait a minute before requesting another code."},429);}
 const recent=await env.DB.prepare("SELECT COUNT(*) AS count FROM email_login_codes WHERE email=? AND created_at>datetime('now','-15 minutes')").bind(email).first<{count:number}>();
 if(Number(recent?.count??0)>=5)return json({error:"Too many code requests. Please try again later."},429);
 const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0"),salt=randomHex();
 const codeHash=await sha256(email+":"+code+":"+salt);
 await env.DB.prepare("INSERT INTO email_login_codes(email,code_hash,salt,expires_at,attempts,created_at) VALUES(?,?,?,datetime('now','+10 minutes'),0,datetime('now')) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,salt=excluded.salt,expires_at=excluded.expires_at,attempts=0,created_at=datetime('now')").bind(email,codeHash,salt).run();
 const delivery=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+env.RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:env.EMAIL_FROM,to:[email],subject:"Your MaseNet sign-in code",text:"Your MaseNet sign-in code is "+code+". It expires in 10 minutes. If you did not request it, ignore this email.",html:"<div style=\"font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:28px;color:#18202c\"><h2>Sign in to MaseNet</h2><p>Your one-time sign-in code:</p><p style=\"font-size:32px;font-weight:700;letter-spacing:8px;padding:16px;background:#f1f5f9;border-radius:12px;text-align:center\">"+code+"</p><p>This code expires in 10 minutes. If you did not request it, ignore this email.</p></div>"})});
 if(!delivery.ok){await env.DB.prepare("DELETE FROM email_login_codes WHERE email=?").bind(email).run();return json({error:"The email provider could not deliver your code. Please try again later."},502);}
 return json({sent:true});
};