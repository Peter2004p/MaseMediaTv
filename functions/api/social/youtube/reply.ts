import { Env, json, currentAdmin } from "../../auth/_shared";
type SocialEnv=Env & {YOUTUBE_CLIENT_ID?:string;YOUTUBE_CLIENT_SECRET?:string;YOUTUBE_TOKEN_ENCRYPTION_KEY?:string};
async function getToken(env:SocialEnv){
 const row=await env.DB.prepare("SELECT encrypted_refresh_token FROM social_connections WHERE provider='youtube'").first<{encrypted_refresh_token:string}>();
 if(!row) throw new Error("YouTube channel is not connected.");
 const raw=Uint8Array.from(atob(env.YOUTUBE_TOKEN_ENCRYPTION_KEY||""),c=>c.charCodeAt(0));
 if(raw.length!==32) throw new Error("YouTube encryption key is invalid.");
 const packed=Uint8Array.from(atob(row.encrypted_refresh_token),c=>c.charCodeAt(0)),iv=packed.slice(0,12),cipher=packed.slice(12);
 const key=await crypto.subtle.importKey("raw",raw.slice().buffer as ArrayBuffer,"AES-GCM",false,["decrypt"]);
 const refresh=new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:iv.slice().buffer as ArrayBuffer},key,cipher.slice().buffer as ArrayBuffer));
 const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:env.YOUTUBE_CLIENT_ID||"",client_secret:env.YOUTUBE_CLIENT_SECRET||"",refresh_token:refresh,grant_type:"refresh_token"})});
 const d=await r.json() as {access_token?:string;error_description?:string};if(!r.ok||!d.access_token)throw new Error(d.error_description||"Could not refresh YouTube access.");return d.access_token;
}
export const onRequestPost:PagesFunction<SocialEnv>=async({request,env})=>{
 const admin=await currentAdmin(request,env);if(!admin||admin.role!=="owner")return json({error:"Only the MaseNet owner can publish YouTube replies."},403);
 const body=await request.json().catch(()=>({})) as {commentId?:string;replyText?:string};
 const commentId=String(body.commentId||"").trim(),replyText=String(body.replyText||"").trim().slice(0,1000);
 if(!commentId||!replyText)return json({error:"Select a draft and provide reply text."},400);
 const row=await env.DB.prepare("SELECT status FROM social_comment_drafts WHERE comment_id=?").bind(commentId).first<{status:string}>();
 if(!row||row.status!=="pending")return json({error:"This reply is not pending approval or was already published."},409);
 try{
  const token=await getToken(env);
  const response=await fetch("https://www.googleapis.com/youtube/v3/comments?part=snippet",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({snippet:{parentId:commentId,textOriginal:replyText}})});
  const data=await response.json() as {id?:string;error?:{message?:string}};
  if(!response.ok)return json({error:data.error?.message||"YouTube rejected the reply."},response.status);
  await env.DB.prepare("UPDATE social_comment_drafts SET draft_text=?,status='published',published_at=datetime('now') WHERE comment_id=? AND status='pending'").bind(replyText,commentId).run();
  return json({published:true,replyId:data.id});
 }catch(e){return json({error:e instanceof Error?e.message:"Reply could not be published."},500)}
};
