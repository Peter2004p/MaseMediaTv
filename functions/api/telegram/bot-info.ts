interface Env { TELEGRAM_BOT_TOKEN?:string; }
export const onRequestGet=async({env}:{env:Env})=>{
 if(!env.TELEGRAM_BOT_TOKEN)return Response.json({error:"MaseNet bot is not configured."},{status:503,headers:{"Cache-Control":"no-store"}});
 try{
  const r=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/getMe");
  const d=await r.json() as {ok?:boolean;result?:{username?:string;first_name?:string};description?:string};
  if(!r.ok||!d.ok||!d.result?.username)return Response.json({error:d.description||"Could not identify the configured MaseNet bot."},{status:502,headers:{"Cache-Control":"no-store"}});
  return Response.json({username:d.result.username,firstName:d.result.first_name},{headers:{"Cache-Control":"no-store"}});
 }catch{return Response.json({error:"Could not contact Telegram right now."},{status:502,headers:{"Cache-Control":"no-store"}});}
};
