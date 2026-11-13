interface Env { DB:D1Database; TELEGRAM_BOT_TOKEN?:string; }
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
async function hmac(key:BufferSource,data:string){const k=await crypto.subtle.importKey("raw",key,{name:"HMAC",hash:"SHA-256"},false,["sign"]);return new Uint8Array(await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(data)));}
const hex=(v:Uint8Array)=>[...v].map(b=>b.toString(16).padStart(2,"0")).join("");
export const onRequestPost=async({request,env}:{request:Request;env:Env})=>{
 if(!env.TELEGRAM_BOT_TOKEN)return json({error:"Telegram bot is not configured."},503);
 const body=await request.json().catch(()=>({})) as {initData?:string};
 const params=new URLSearchParams(String(body.initData||""));const hash=params.get("hash")||"";params.delete("hash");
 const authDate=Number(params.get("auth_date")||0);
 const nowSeconds=Math.floor(Date.now()/1000);
 if(!hash||!Number.isSafeInteger(authDate)||authDate<=0||authDate>nowSeconds+60||nowSeconds-authDate>86400)return json({error:"Your Telegram session expired. Close and reopen MaseNet."},401);
 const entries:Array<[string,string]>=[];params.forEach((v,k)=>entries.push([k,v]));
 const check=entries.sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+"="+v).join("\n");
 const secret=await hmac(new TextEncoder().encode("WebAppData"),env.TELEGRAM_BOT_TOKEN);
 const expected=hex(await hmac(secret,check));
 if(expected.length!==hash.length)return json({error:"Telegram session validation failed."},401);
 let mismatch=0;for(let i=0;i<expected.length;i++)mismatch|=expected.charCodeAt(i)^hash.charCodeAt(i);
 if(mismatch!==0)return json({error:"Telegram session validation failed."},401);
 let user:{id?:number|string}|null=null;try{user=JSON.parse(params.get("user")||"null")}catch{}
 if(!user?.id)return json({error:"Telegram user was not found."},401);
 const chatId=String(user.id);
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_access_verification (chat_id TEXT PRIMARY KEY,youtube_ok INTEGER NOT NULL DEFAULT 0,masemedia_ok INTEGER NOT NULL DEFAULT 0,moondramac_ok INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_access_submissions (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,display_name TEXT NOT NULL,username TEXT,status TEXT NOT NULL DEFAULT 'pending',submitted_at TEXT NOT NULL DEFAULT (datetime('now')),reviewed_at TEXT)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_access_verification (chat_id TEXT PRIMARY KEY,youtube_ok INTEGER NOT NULL DEFAULT 0,youtube_provisional INTEGER NOT NULL DEFAULT 0,masemedia_ok INTEGER NOT NULL DEFAULT 0,moondramac_ok INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
 try{await env.DB.prepare("ALTER TABLE telegram_access_verification ADD COLUMN youtube_provisional INTEGER NOT NULL DEFAULT 0").run()}catch{/* already exists */}
 try{await env.DB.prepare("ALTER TABLE telegram_access_verification ADD COLUMN membership_checked_at TEXT").run()}catch{/* already exists */}
 const saved=await env.DB.prepare("SELECT youtube_ok,youtube_provisional,masemedia_ok,moondramac_ok,membership_checked_at FROM telegram_access_verification WHERE chat_id=?").bind(chatId).first<{youtube_ok:number;youtube_provisional:number;masemedia_ok:number;moondramac_ok:number;membership_checked_at:string|null}>();
 const membership={masemedia:!!saved?.masemedia_ok,moondramac:!!saved?.moondramac_ok};
 const checkedAt=saved?.membership_checked_at?Date.parse(saved.membership_checked_at.replace(" ","T")+"Z"):0;
 const membershipFresh=Number.isFinite(checkedAt)&&Date.now()-checkedAt<30000;
 if(!membershipFresh){
  for(const [channel,key] of [["@MaseMediaTv","masemedia"],["@MoonDramaC","moondramac"]] as const){
   const r=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/getChatMember?chat_id="+encodeURIComponent(channel)+"&user_id="+encodeURIComponent(chatId));
   const d=await r.json().catch(()=>({})) as {ok?:boolean;result?:{status?:string};description?:string};
   membership[key]=!!r.ok&&!!d.ok&&["member","administrator","creator"].includes(String(d.result?.status||""));
  }
  await env.DB.prepare("INSERT INTO telegram_access_verification (chat_id,masemedia_ok,moondramac_ok,membership_checked_at,updated_at) VALUES (?,?,?,datetime('now'),datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET masemedia_ok=excluded.masemedia_ok,moondramac_ok=excluded.moondramac_ok,membership_checked_at=datetime('now'),updated_at=datetime('now')").bind(chatId,membership.masemedia?1:0,membership.moondramac?1:0).run();
 }
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_access_reviews(chat_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'clear',reason TEXT NOT NULL DEFAULT '',flagged_at TEXT,deadline_at TEXT,updated_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
 let review=await env.DB.prepare("SELECT status,reason,deadline_at FROM telegram_access_reviews WHERE chat_id=?").bind(chatId).first<{status:string;reason:string;deadline_at:string|null}>();
 if(review?.status==="warning"&&review.deadline_at){
  const due=await env.DB.prepare("SELECT CASE WHEN datetime(?)<=datetime('now') THEN 1 ELSE 0 END AS due").bind(review.deadline_at).first<{due:number}>();
  if(due?.due){await env.DB.prepare("UPDATE telegram_access_reviews SET status='restricted',updated_at=datetime('now') WHERE chat_id=? AND status='warning' AND datetime(deadline_at)<=datetime('now')").bind(chatId).run();review={...review,status:"restricted"};}
 }
 const reviewActive=!!review&&["warning","restricted","submitted"].includes(review.status);
 const reviewRestricted=review?.status==="restricted";
 const youtubeVerified=!!saved?.youtube_ok&&!reviewRestricted;
 const provisionalAccess=!youtubeVerified&&!reviewRestricted&&!!saved?.youtube_provisional;
 const youtubeEligible=youtubeVerified||provisionalAccess;
 const latestSubmission=await env.DB.prepare("SELECT status,ai_verdict,ai_reason FROM telegram_access_submissions WHERE chat_id=? ORDER BY submitted_at DESC LIMIT 1").bind(chatId).first<{status:string;ai_verdict:string|null;ai_reason:string|null}>();
 return json({ok:true,youtubeVerified,provisionalAccess,latestSubmission:latestSubmission||null,membership,review:reviewActive?{status:review?.status,reason:review?.reason,deadlineAt:review?.deadline_at}:null,accessGranted:youtubeEligible&&membership.masemedia&&membership.moondramac,missing:[!youtubeEligible?"youtube":null,!membership.masemedia?"masemedia":null,!membership.moondramac?"moondramac":null].filter(Boolean)});
};
