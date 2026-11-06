interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_PROMO_CRON_SECRET?: string;
}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8"}});
export const onRequestPost=async({request,env}:{request:Request;env:Env})=>{
  const expected=String(env.TELEGRAM_PROMO_CRON_SECRET||"");
  if(!expected||request.headers.get("authorization")!=="Bearer "+expected)return json({ok:false,error:"Unauthorized"},401);
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_WEBHOOK_SECRET)return json({ok:false,error:"Telegram bot credentials are not configured"},503);
  const url="https://masetv-cloudflare-migration.pages.dev/api/telegram/webhook/masetv";
  const response=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/setWebhook",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({url,drop_pending_updates:false,allowed_updates:["message","edited_message","channel_post","my_chat_member","callback_query"],secret_token:env.TELEGRAM_WEBHOOK_SECRET})
  });
  const result=await response.json().catch(()=>({})) as {ok?:boolean;description?:string};
  if(!response.ok||!result.ok)return json({ok:false,error:result.description||"Telegram rejected webhook repair"},502);
  const infoResponse=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/getWebhookInfo");
  const info=await infoResponse.json().catch(()=>({})) as {ok?:boolean;result?:{url?:string;allowed_updates?:string[];pending_update_count?:number;last_error_message?:string}};
  return json({ok:true,webhookUrl:info.result?.url||"",allowedUpdates:info.result?.allowed_updates||[],pendingUpdateCount:info.result?.pending_update_count??0,lastErrorMessage:info.result?.last_error_message||""});
};
