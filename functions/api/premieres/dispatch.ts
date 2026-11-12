interface Env{DB:D1Database;TELEGRAM_BOT_TOKEN?:string;PROMO_CRON_SECRET?:string;TELEGRAM_PROMO_CRON_SECRET?:string;TELEGRAM_MINI_APP_URL?:string;TELEGRAM_WEBAPP_URL?:string}
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
export const onRequestPost:PagesFunction<Env>=async({request,env})=>{
 const secrets=[env.PROMO_CRON_SECRET,env.TELEGRAM_PROMO_CRON_SECRET].map(x=>String(x||"").trim()).filter(Boolean);
 if(!secrets.length||!secrets.some(x=>request.headers.get("authorization")==="Bearer "+x))return json({ok:false,error:"Unauthorized"},401);
 if(!env.DB||!env.TELEGRAM_BOT_TOKEN)return json({ok:false,error:"Telegram bot or database is unavailable."},503);
 try{
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_subscribers(chat_id TEXT PRIMARY KEY,chat_type TEXT NOT NULL,title TEXT,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')))").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS premiere_delivery_log(premiere_id TEXT NOT NULL,chat_id TEXT NOT NULL,sent_at TEXT NOT NULL DEFAULT(datetime('now')),PRIMARY KEY(premiere_id,chat_id))").run();
  const due=await env.DB.prepare("SELECT id,title_name,description,premiere_at FROM title_premieres WHERE status='scheduled' AND datetime(premiere_at)<=datetime('now') AND datetime(premiere_at)>=datetime('now','-2 days') ORDER BY premiere_at LIMIT 20").all<{id:string;title_name:string;description:string;premiere_at:string}>();
  const channels=await env.DB.prepare("SELECT chat_id,title FROM telegram_subscribers WHERE active=1 AND chat_type IN ('channel','supergroup')").all<{chat_id:string;title:string|null}>();
  let sent=0,failed=0,alreadySent=0;
  const appUrl=(env.TELEGRAM_MINI_APP_URL||env.TELEGRAM_WEBAPP_URL||"https://masetv-cloudflare-migration.pages.dev").trim();
  for(const p of due.results||[])for(const ch of channels.results||[]){
   const prior=await env.DB.prepare("SELECT 1 AS sent FROM premiere_delivery_log WHERE premiere_id=? AND chat_id=?").bind(p.id,ch.chat_id).first();
   if(prior){alreadySent++;continue;}
   const text="🎬 MASENET PREMIERE IS NOW LIVE\n\n"+p.title_name+"\n\n"+String(p.description||"").slice(0,650)+"\n\nOpen MaseNet to watch now.";
   const payload:Record<string,unknown>={chat_id:ch.chat_id,text};
   if(appUrl.startsWith("https://"))payload.reply_markup={inline_keyboard:[[{text:"▶ Open MaseNet",url:appUrl}]]};
   try{
    const response=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
    const result=await response.json().catch(()=>({})) as {ok?:boolean;description?:string};
    if(!response.ok||!result.ok){failed++;console.error("Premiere announcement failed",p.id,ch.chat_id,response.status,result.description||"Telegram error");continue;}
    await env.DB.prepare("INSERT OR IGNORE INTO premiere_delivery_log(premiere_id,chat_id) VALUES(?,?)").bind(p.id,ch.chat_id).run();sent++;
   }catch(e){failed++;console.error("Premiere announcement exception",p.id,ch.chat_id,e instanceof Error?e.message:String(e));}
  }
  return json({ok:true,due:(due.results||[]).length,channels:(channels.results||[]).length,sent,failed,alreadySent});
 }catch(e){console.error("Premiere dispatch failed",e instanceof Error?e.message:String(e));return json({ok:false,error:"Premiere notification dispatch failed."},500);}
};