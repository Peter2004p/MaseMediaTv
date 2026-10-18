import { json, ensureTables, cookieToken, sha256, clearCookie, originAllowed } from "./_helpers.js";
export async function onRequestPost({request,env}) {
 if(!env.DB)return json({ok:true},200,{"Set-Cookie":clearCookie()});
 if(!originAllowed(request))return json({error:"Request origin rejected."},403);
 try{await ensureTables(env.DB);const token=cookieToken(request);if(token){const hash=await sha256(token);await env.DB.prepare("DELETE FROM user_sessions WHERE token_hash=?").bind(hash).run()}return json({ok:true},200,{"Set-Cookie":clearCookie()})}
 catch{return json({error:"Could not end session."},500,{"Set-Cookie":clearCookie()})}
}
