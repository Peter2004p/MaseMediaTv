import { json, originAllowed, ensureTables, passwordHash, createSession, sessionCookie } from "./_helpers.js";
export async function onRequestPost({request,env}) {
 if(!env.DB)return json({error:"Account service is not configured."},503);
 if(!originAllowed(request))return json({error:"Request origin rejected."},403);
 let body;try{body=await request.json()}catch{return json({error:"Please submit valid account details."},400)}
 const email=typeof body?.email==="string"?body.email.trim().toLowerCase():"";
 const password=typeof body?.password==="string"?body.password:"";
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return json({error:"Enter a valid email address."},400);
 if(password.length<10||password.length>1024)return json({error:"Use a password between 10 and 1024 characters."},400);
 try{
  await ensureTables(env.DB);
  const existing=await env.DB.prepare("SELECT id FROM masenet_account_users WHERE email=? LIMIT 1").bind(email).first();
  if(existing)return json({error:"An account with this email already exists. Sign in instead."},409);
  const id=crypto.randomUUID(),salt=[...crypto.getRandomValues(new Uint8Array(24))].map(v=>v.toString(16).padStart(2,"0")).join("");
  const hash=await passwordHash(password,salt),now=Math.floor(Date.now()/1000);
  await env.DB.prepare("INSERT INTO masenet_account_users (id,email,password_salt,password_hash,created_at) VALUES (?,?,?,?,?)").bind(id,email,salt,hash,now).run();
  const session=await createSession(env.DB,id);
  return json({ok:true,user:{id,email,createdAt:now},expiresAt:session.expiresAt},201,{"Set-Cookie":sessionCookie(session.token)});
 }catch{return json({error:"Could not create your account. Please try again."},500)}
}
