interface Env { DB:D1Database; TELEGRAM_BOT_TOKEN?:string; OPENAI_API_KEY?:string; GEMINI_API_KEY?:string; }
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
async function hmac(key:BufferSource,data:string){const k=await crypto.subtle.importKey("raw",key,{name:"HMAC",hash:"SHA-256"},false,["sign"]);return new Uint8Array(await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(data)));}
const hex=(v:Uint8Array)=>[...v].map(b=>b.toString(16).padStart(2,"0")).join("");
function constantTimeEqual(a:string,b:string){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
async function checkMembership(token:string,channel:string,userId:string){
 try{
  const url="https://api.telegram.org/bot"+token+"/getChatMember?chat_id="+encodeURIComponent(channel)+"&user_id="+encodeURIComponent(userId);
  const r=await fetch(url,{signal:AbortSignal.timeout(8000)});
  const d=await r.json().catch(()=>({})) as {ok?:boolean;result?:{status?:string};description?:string};
  if(!r.ok||!d.ok)return {member:false,error:d.description||"Telegram could not confirm membership. The bot may need administrator access in this channel."};
  return {member:["member","administrator","creator"].includes(String(d.result?.status||"")),error:""};
 }catch{return {member:false,error:"Telegram membership check timed out. Refresh and try again."};}
}
export const onRequestPost=async({request,env}:{request:Request;env:Env})=>{
 if(!env.TELEGRAM_BOT_TOKEN)return json({error:"Telegram verification is not configured."},503);
 const body=await request.json().catch(()=>({})) as {initData?:string;imageDataUrl?:string};
 const params=new URLSearchParams(String(body.initData||""));const hash=params.get("hash")||"";params.delete("hash");
 const authDate=Number(params.get("auth_date")||0);
 if(!hash||!authDate||authDate>Math.floor(Date.now()/1000)+60||Math.floor(Date.now()/1000)-authDate>86400)return json({error:"Open MaseNet again from Telegram and retry."},401);
 const entries:Array<[string,string]>=[];params.forEach((v,k)=>entries.push([k,v]));
 const check=entries.sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+"="+v).join("\n");
 const secret=await hmac(new TextEncoder().encode("WebAppData"),env.TELEGRAM_BOT_TOKEN);
 const expected=hex(await hmac(secret,check));if(!constantTimeEqual(expected,hash))return json({error:"Telegram session validation failed."},401);
 let user:{id?:number|string}|null=null;try{user=JSON.parse(params.get("user")||"null")}catch{}
 if(!user?.id)return json({error:"Telegram user was not found."},401);
 const image=String(body.imageDataUrl||"");const match=image.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
 if(!match||image.length>14000000)return json({error:"Choose a valid screenshot under 10 MB."},400);
 if(!env.OPENAI_API_KEY&&!env.GEMINI_API_KEY)return json({error:"Screenshot verification is temporarily unavailable. Use the MaseNet bot for admin review."},503);
 const mime=match[1],base64=match[2];
 const prompt="Verify a YouTube subscription screenshot for MaseNet. Inspect the full image including screenshots embedded inside other screenshots. Accept only if it clearly shows the official YouTube channel named MaseMediaTV or MaseMedia TV (or handle @MaseMedia_Tv / @masemedia_tv) AND the subscription control visibly says Subscribed. Reject if it says Subscribe, the channel is different, or subscription state is not visible. Return JSON only: {\"passed\":boolean,\"reason\":\"short reason\"}.";
 let passed=false,reason="Could not confidently confirm the subscription.";
 if(env.OPENAI_API_KEY){
  try{
   const r=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+env.OPENAI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:"gpt-4o-mini",temperature:0,response_format:{type:"json_object"},messages:[{role:"system",content:prompt},{role:"user",content:[{type:"text",text:"Does this screenshot show the official MaseMediaTV YouTube channel with Subscribed active?"},{type:"image_url",image_url:{url:image,detail:"high"}}]}]})});
   if(r.ok){const d=await r.json() as {choices?:Array<{message?:{content?:string}}>};const v=JSON.parse(d.choices?.[0]?.message?.content||"{}") as {passed?:boolean;reason?:string};passed=v.passed===true;reason=String(v.reason||reason);}
  }catch(e){console.error("Mini App OpenAI screenshot check failed",String(e));}
 }
 if(!passed&&env.GEMINI_API_KEY){
  try{
   const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key="+encodeURIComponent(env.GEMINI_API_KEY),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt+"\nDoes this image prove the official channel is subscribed?"},{inline_data:{mime_type:mime,data:base64}}]}],generationConfig:{temperature:0,responseMimeType:"application/json",maxOutputTokens:160}})});
   if(r.ok){const d=await r.json() as {candidates?:Array<{content?:{parts?:Array<{text?:string}>}}>};const raw=d.candidates?.[0]?.content?.parts?.map(x=>x.text||"").join("\n")||"{}";const v=JSON.parse(raw) as {passed?:boolean;reason?:string};passed=v.passed===true;reason=String(v.reason||reason);}
  }catch(e){console.error("Mini App Gemini screenshot check failed",String(e));}
 }
 if(!passed)return json({verified:false,error:reason},422);
 const chatId=String(user.id);
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_access_verification (chat_id TEXT PRIMARY KEY,youtube_ok INTEGER NOT NULL DEFAULT 0,masemedia_ok INTEGER NOT NULL DEFAULT 0,moondramac_ok INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
 await env.DB.prepare("INSERT INTO telegram_access_verification (chat_id,youtube_ok,updated_at) VALUES (?,1,datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET youtube_ok=1,updated_at=datetime('now')").bind(chatId).run();
 const [main,second]=await Promise.all([checkMembership(env.TELEGRAM_BOT_TOKEN,"@MaseMediaTv",chatId),checkMembership(env.TELEGRAM_BOT_TOKEN,"@MoonDramaC",chatId)]);
 const membership={masemedia:main.member,moondramac:second.member};
 await env.DB.prepare("UPDATE telegram_access_verification SET masemedia_ok=?,moondramac_ok=?,updated_at=datetime('now') WHERE chat_id=?").bind(membership.masemedia?1:0,membership.moondramac?1:0,chatId).run();
 return json({verified:true,youtubeVerified:true,membership,accessGranted:membership.masemedia&&membership.moondramac,checkErrors:{masemedia:main.error||null,moondramac:second.error||null}});
};
