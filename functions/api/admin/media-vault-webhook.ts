import { json, requireOwner, type Env as AuthEnv } from "../auth/_shared";
import { loadMediaVaultConfig } from "./_media-vault-config";
interface Env extends AuthEnv { MASE_STREAM_BOT_WEBHOOK_SECRET?: string; }
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const gate = await requireOwner(request, env);
  if (gate.response) return gate.response;
  const origin = new URL(request.url).origin;
  if (request.headers.get("Origin") !== origin) return json({ ok:false,error:"Same-origin confirmation is required." },403);
  const secret=String(env.MASE_STREAM_BOT_WEBHOOK_SECRET||"").trim();
  if(!secret) return json({ok:false,error:"The Preview vault encryption key is not configured."},503);
  const config=await loadMediaVaultConfig(env.DB,secret);
  if(!config) return json({ok:false,error:"Connect and verify the manager bot in the Media Vault setup panel first."},503);
  const token=config.token;
  if(!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) return json({ok:false,error:"Webhook secret format is invalid."},500);
  // Bind registration to the exact environment handling this authenticated request.
  // This prevents a Preview admin action from silently redirecting Telegram updates to Production.
  const webhookUrl = new URL("/api/telegram/media-vault", origin).toString();
  const call=async(method:string,payload?:Record<string,unknown>)=>{
    const response=await fetch("https://api.telegram.org/bot"+token+"/"+method,{method:payload?"POST":"GET",headers:payload?{"content-type":"application/json"}:undefined,body:payload?JSON.stringify(payload):undefined});
    const data=await response.json().catch(()=>({})) as {ok?:boolean;description?:string;result?:Record<string,unknown>};
    if(!response.ok||!data.ok) throw new Error(data.description||"Telegram API request failed.");
    return data.result||{};
  };
  try {
    const previous=await call("getWebhookInfo");
    const previousUrl=String(previous.url||"");
    if(previousUrl && previousUrl!==webhookUrl) return json({ok:false,error:"This manager bot already has a different webhook URL. I did not replace it, to protect the existing bot connection. Use a separate Preview test bot for Preview, or keep this bot connected to its current environment."},409);
    await call("setWebhook",{url:webhookUrl,secret_token:secret,allowed_updates:["message"],drop_pending_updates:false});
    const info=await call("getWebhookInfo");
    if(String(info.url||"")!==webhookUrl) return json({ok:false,error:"Telegram webhook URL did not verify."},502);
    return json({ok:true,message:"MaseNet Media Vault webhook registered and verified.",webhook:info.url,pendingUpdates:Number(info.pending_update_count||0),lastErrorMessage:info.last_error_message||null});
  } catch(error) { return json({ok:false,error:error instanceof Error?error.message:"Could not register the Media Vault webhook."},502); }
};
