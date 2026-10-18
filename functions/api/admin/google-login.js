const ALLOWED_EMAIL="pb5089780@gmail.com";
const COOKIE="masenet_admin";
const SESSION_SECONDS=60*60*12;
const hex=bytes=>[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");
async function sha256(value){return hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))}
function json(body,status=200,extra={}){return Response.json(body,{status,headers:{"Cache-Control":"no-store","Pragma":"no-cache","X-Content-Type-Options":"nosniff",...extra}})}
function cookie(value,maxAge){return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`}
export async function onRequestPost({request,env}){
 if(!env.DB)return json({error:"Authentication database is unavailable."},503);
 if(request.headers.get("Origin")&&request.headers.get("Origin")!==new URL(request.url).origin)return json({error:"Request origin rejected."},403);
 const clientId=typeof env.GOOGLE_CLIENT_ID==="string"?env.GOOGLE_CLIENT_ID.trim():"";
 if(!clientId)return json({error:"Google sign-in is not configured yet. Add the Google OAuth Client ID to the preview environment."},503);
 let body;try{body=await request.json()}catch{return json({error:"Invalid request."},400)}
 if(typeof body?.credential!=="string"||body.credential.length<100||body.credential.length>10000)return json({error:"Google did not return a valid sign-in credential."},400);
 let claims;
 try{
  const verify=await fetch("https://oauth2.googleapis.com/tokeninfo?id_token="+encodeURIComponent(body.credential),{headers:{Accept:"application/json"}});
  if(!verify.ok)return json({error:"Google could not verify this sign-in. Please try again."},401);
  claims=await verify.json();
 }catch{return json({error:"Could not reach Google's verification service. Try again."},502)}
 if(claims.aud!==clientId||String(claims.email_verified)!=="true"||String(claims.email||"").toLowerCase()!==ALLOWED_EMAIL)return json({error:"This Google account is not authorized for MaseNet admin access."},403);
 try{
  const existing=await env.DB.prepare("SELECT id FROM admins WHERE id=1 LIMIT 1").first();
  if(existing)return json({error:"An admin already exists in this preview database. Google sign-in bootstrap is one-time; do not reset the existing admin. Sign in with the existing admin password."},409);
  const salt=hex(crypto.getRandomValues(new Uint8Array(24)));
  const inaccessiblePassword=hex(crypto.getRandomValues(new Uint8Array(48)));
  const passwordHash=await sha256(inaccessiblePassword+salt);
  const created=await env.DB.prepare("INSERT INTO admins (id,salt,password_hash) SELECT 1,?,? WHERE NOT EXISTS (SELECT 1 FROM admins WHERE id=1)").bind(salt,passwordHash).run();
  if(!created.meta?.changes)return json({error:"An admin was created by another request. Refresh and sign in again."},409);
  const token=hex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash=await sha256(token),expiresAt=Math.floor(Date.now()/1000)+SESSION_SECONDS;
  await env.DB.prepare("INSERT INTO sessions (token_hash,expires_at) VALUES (?,?)").bind(tokenHash,expiresAt).run();
  return json({ok:true,email:ALLOWED_EMAIL,expiresAt},200,{"Set-Cookie":cookie(token,SESSION_SECONDS)});
 }catch{return json({error:"Could not create the Google admin session. Check the preview database schema."},500)}
}
