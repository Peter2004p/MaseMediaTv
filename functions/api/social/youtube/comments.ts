import { Env, json, currentAdmin } from "../../auth/_shared";

type SocialEnv = Env & { YOUTUBE_CLIENT_ID?:string; YOUTUBE_CLIENT_SECRET?:string; YOUTUBE_TOKEN_ENCRYPTION_KEY?:string; OPENAI_API_KEY?:string; OPENAI_MODEL?:string; GEMINI_API_KEY?:string; GEMINI_MODEL?:string };
async function accessToken(env:SocialEnv):Promise<string>{
  const row=await env.DB.prepare("SELECT encrypted_refresh_token FROM social_connections WHERE provider='youtube'").first<{encrypted_refresh_token:string}>();
  if(!row?.encrypted_refresh_token) throw new Error("YouTube channel is not connected.");
  if(!env.YOUTUBE_TOKEN_ENCRYPTION_KEY) throw new Error("YouTube token encryption key is missing.");
  const raw=Uint8Array.from(atob(env.YOUTUBE_TOKEN_ENCRYPTION_KEY),c=>c.charCodeAt(0));
  if(raw.length!==32) throw new Error("YouTube encryption key is invalid.");
  const packed=Uint8Array.from(atob(row.encrypted_refresh_token),c=>c.charCodeAt(0));
  const iv=packed.slice(0,12), cipher=packed.slice(12);
  const key=await crypto.subtle.importKey("raw",raw.slice().buffer as ArrayBuffer,"AES-GCM",false,["decrypt"]);
  const refreshToken=new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:iv.slice().buffer as ArrayBuffer},key,cipher.slice().buffer as ArrayBuffer));
  const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:env.YOUTUBE_CLIENT_ID||"",client_secret:env.YOUTUBE_CLIENT_SECRET||"",refresh_token:refreshToken,grant_type:"refresh_token"})});
  const data=await response.json() as {access_token?:string;error_description?:string};
  if(!response.ok||!data.access_token) throw new Error(data.error_description||"Google could not refresh the YouTube access token.");
  return data.access_token;
}
export const onRequestGet:PagesFunction<SocialEnv>=async({request,env})=>{
  const admin=await currentAdmin(request,env);
  if(!admin||admin.role!=="owner") return json({error:"Only the MaseNet owner can read YouTube comments."},403);
  try{
    const token=await accessToken(env);
    const response=await fetch("https://www.googleapis.com/youtube/v3/commentThreads?part=snippet,replies&allThreadsRelatedToChannelId="+encodeURIComponent((await env.DB.prepare("SELECT channel_id FROM social_connections WHERE provider='youtube'").first<{channel_id:string}>())?.channel_id||"")+"&maxResults=30&order=time&textFormat=plainText",{headers:{Authorization:"Bearer "+token}});
    const data=await response.json() as {items?:Array<any>;error?:{message?:string}};
    if(!response.ok) return json({error:data.error?.message||"YouTube comments could not be loaded."},response.status);
    const items=(data.items||[]).map(item=>{const s=item.snippet?.topLevelComment?.snippet||{};return {id:item.id,commentId:item.snippet?.topLevelComment?.id,videoId:item.snippet?.videoId,videoTitle:item.snippet?.videoTitle||"YouTube video",author:s.authorDisplayName||"Viewer",text:s.textDisplay||s.textOriginal||"",publishedAt:s.publishedAt,likeCount:s.likeCount||0,replyCount:item.snippet?.totalReplyCount||0}});
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS social_comment_drafts (id TEXT PRIMARY KEY, comment_id TEXT NOT NULL UNIQUE, video_id TEXT, video_title TEXT, author TEXT, comment_text TEXT, draft_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), published_at TEXT)").run();
    const drafts=await env.DB.prepare("SELECT comment_id AS commentId,draft_text AS draftText,status FROM social_comment_drafts WHERE status IN ('pending','published')").all<{commentId:string;draftText:string;status:string}>();
    const map=new Map((drafts.results||[]).map(x=>[x.commentId,x]));
    return json({items:items.map(x=>({...x,draft:map.get(x.commentId)||null})),count:items.length});
  }catch(e){return json({error:e instanceof Error?e.message:"Could not load YouTube comments."},500)}
};
export const onRequestPost:PagesFunction<SocialEnv>=async({request,env})=>{
  const admin=await currentAdmin(request,env);
  if(!admin||admin.role!=="owner") return json({error:"Only the MaseNet owner can create reply drafts."},403);
  const body=await request.json().catch(()=>({})) as {commentId?:string;videoId?:string;videoTitle?:string;author?:string;commentText?:string};
  const commentId=String(body.commentId||"").slice(0,180), commentText=String(body.commentText||"").trim().slice(0,3000);
  if(!commentId||!commentText) return json({error:"A YouTube comment is required."},400);
  if(!env.GEMINI_API_KEY&&!env.OPENAI_API_KEY) return json({error:"No AI provider is configured. Add GEMINI_API_KEY or OPENAI_API_KEY in Cloudflare Pages secrets."},503);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS social_comment_drafts (id TEXT PRIMARY KEY, comment_id TEXT NOT NULL UNIQUE, video_id TEXT, video_title TEXT, author TEXT, comment_text TEXT, draft_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), published_at TEXT)").run();
  const prompt="You write helpful, natural, concise public replies for the official MaseMedia TV YouTube channel. Reply to the viewer's comment in a warm, respectful tone. Do not claim a title is available, promise release dates, ask for personal information, reveal private details, or use spammy promotion. If the viewer reports a problem, acknowledge it and suggest contacting MaseNet support without inventing contact details. Keep the reply under 450 characters. Return only the reply text.";
  const ai=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{"Authorization":"Bearer "+env.OPENAI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:env.OPENAI_MODEL||"gpt-4o-mini",temperature:0.5,max_tokens:180,messages:[{role:"system",content:prompt},{role:"user",content:"Video: "+String(body.videoTitle||"").slice(0,200)+"\nViewer: "+String(body.author||"").slice(0,100)+"\nComment: "+commentText}]})});
  const result=await ai.json() as {choices?:Array<{message?:{content?:string}}>;error?:{message?:string}};
  if(!ai.ok) return json({error:result.error?.message||"AI could not draft a reply."},502);
  const draft=String(result.choices?.[0]?.message?.content||"").trim().slice(0,1000);
  if(!draft) return json({error:"AI returned an empty reply."},502);
  const id=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO social_comment_drafts(id,comment_id,video_id,video_title,author,comment_text,draft_text,status) VALUES(?,?,?,?,?,?,?,'pending') ON CONFLICT(comment_id) DO UPDATE SET video_id=excluded.video_id,video_title=excluded.video_title,author=excluded.author,comment_text=excluded.comment_text,draft_text=excluded.draft_text,status='pending',created_at=datetime('now')").bind(id,commentId,String(body.videoId||""),String(body.videoTitle||""),String(body.author||""),commentText,draft).run();
  return json({draft,status:"pending"});
};
