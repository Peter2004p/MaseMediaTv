import { json, requireAdmin } from "../auth/_shared";
interface Env { DB: D1Database; ADMIN_EMAIL?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_WEBHOOK_SECRET?: string; }
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
 const gate=await requireAdmin(request,env); if(gate.response) return gate.response;
 if(!env.TELEGRAM_BOT_TOKEN) return json({error:"Add TELEGRAM_BOT_TOKEN as a Cloudflare Pages secret first."},503);
 const origin=new URL(request.url).origin;
 const secret=env.TELEGRAM_WEBHOOK_SECRET;
 const response=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/setWebhook",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({url:origin+"/api/telegram/webhook/masetv",drop_pending_updates:false,allowed_updates:["message","edited_message"],...(secret?{secret_token:secret}:{})})
 });
 const data=await response.json().catch(()=>({ok:false,description:"Telegram returned an unreadable response"})) as {ok?:boolean;description?:string;result?:boolean};
 if(!response.ok||!data.ok) return json({error:data.description||"Telegram webhook registration failed."},502);
 await env.DB.prepare("INSERT INTO site_settings(key,value_json,updated_at) VALUES('telegram_webhook',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=datetime('now')")
 .bind(JSON.stringify({url:origin+"/api/telegram/webhook/masetv",configured:true})).run();
 return json({ok:true,webhookUrl:origin+"/api/telegram/webhook/masetv",description:data.description||"Webhook registered"});
};