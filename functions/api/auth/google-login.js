import { json, originAllowed, ensureTables, createSession, sessionCookie, passwordHash } from "./_helpers.js";
export async function onRequestPost({request,env}) {
 if(!env.DB)return json({error:"Account database is unavailable."},503);
 if(!originAllowed(request))return json({error:"Request origin rejected."},403);
 const clientId=typeof env.GOOGLE_CLIENT_ID==="string"?env.GOOGLE_CLIENT_ID.trim():"";
 if(!clientId)return json({error:"Google sign-in is not configured for this site yet."},503);
 let body;try{body=await request.json()}catch{return json({error:"Invalid Google sign-in request."},400)}
 const credential=body?.credential;
 if(typeof credential!=="string"||credential.length<100||credential.length>10000)return json({error:"Google did not return a valid credential. Please try again."},400);
 let claims;
 try{const response=await fetch("https://oauth2.googleapis.com/tokeninfo?id_token="+encodeURIComponent(credential),{headers:{Accept:"application/json"}});if(!response.ok)return json({error:"Google could not verify this sign-in. Please try again."},401);claims=await response.json()}
 catch{return json({error:"Could not contact Google to verify your account. Please try again."},502)}
 const email=typeof claims.email==="string"?claims.email.trim().toLowerCase():"";
 if(claims.aud!==clientId||String(claims.email_verified)!=="true"||!email)return json({error:"Google account verification failed. Check the OAuth configuration and try again."},401);
 try{
  await ensureTables(env.DB);
  let user=await env.DB.prepare("SELECT id,email,created_at FROM masenet_account_users WHERE email=? LIMIT 1").bind(email).first();
  if(!user){
   const id=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
   // Google-verified accounts do not use a local password; the random hash cannot be used to sign in with a chosen password.
   const salt=[...crypto.getRandomValues(new Uint8Array(24))].map(v=>v.toString(16).padStart(2,"0")).join("");
   const randomPassword=[...crypto.getRandomValues(new Uint8Array(48))].map(v=>v.toString(16).padStart(2,"0")).join("");
   const hash=await passwordHash(randomPassword,salt);
   await env.DB.prepare("INSERT INTO masenet_account_users (id,email,password_salt,password_hash,created_at) VALUES (?,?,?,?,?)").bind(id,email,salt,hash,now).run();
   user={id,email,created_at:now};
  }
  const session=await createSession(env.DB,user.id);
  return json({ok:true,user:{id:user.id,email:user.email,createdAt:user.created_at},expiresAt:session.expiresAt},200,{"Set-Cookie":sessionCookie(session.token)});
 }catch{return json({error:"Could not finish Google sign-in. Please try again."},500)}
}
