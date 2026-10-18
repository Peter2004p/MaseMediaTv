import { json, originAllowed, ensureTables, passwordHash, createSession, sessionCookie } from "./_helpers.js";
function equal(a,b){if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0}
export async function onRequestPost({request,env}) {
 if(!env.DB)return json({error:"Account service is not configured."},503);
 if(!originAllowed(request))return json({error:"Request origin rejected."},403);
 let body;try{body=await request.json()}catch{return json({error:"Please submit your email and password."},400)}
 const email=typeof body?.email==="string"?body.email.trim().toLowerCase():"",password=typeof body?.password==="string"?body.password:"";
 if(!email||!password||password.length>1024)return json({error:"Enter your email and password."},400);
 try{
  await ensureTables(env.DB);
  const user=await env.DB.prepare("SELECT id,email,password_salt,password_hash,created_at FROM users WHERE email=? LIMIT 1").bind(email).first();
  if(!user)return json({error:"Email or password is incorrect."},401);
  const candidate=await passwordHash(password,user.password_salt);
  if(!equal(candidate,user.password_hash))return json({error:"Email or password is incorrect."},401);
  const session=await createSession(env.DB,user.id);
  return json({ok:true,user:{id:user.id,email:user.email,createdAt:user.created_at},expiresAt:session.expiresAt},200,{"Set-Cookie":sessionCookie(session.token)});
 }catch{return json({error:"Could not sign in right now. Please try again."},500)}
}
