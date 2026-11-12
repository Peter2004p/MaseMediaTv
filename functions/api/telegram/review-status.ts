import { json, cookie, sha256 } from "../auth/_shared";
interface Env { DB:D1Database; }
export const onRequestGet:PagesFunction<Env>=async({request,env})=>{
 try{
  const token=cookie(request,"masetv_user_session");
  if(!token)return json({active:false},200);
  const user=await env.DB.prepare("SELECT u.email FROM site_user_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>datetime('now')").bind(await sha256(token)).first<{email:string}>();
  if(!user?.email||!user.email.startsWith("telegram-"))return json({active:false},200);
  const chatId=user.email.slice("telegram-".length).replace(/@telegram\.local$/,"");
  if(!/^\d+$/.test(chatId))return json({active:false},200);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_access_reviews(
    chat_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'clear',reason TEXT NOT NULL DEFAULT '',
    flagged_at TEXT,deadline_at TEXT,updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  let row=await env.DB.prepare("SELECT status,reason,flagged_at,deadline_at FROM telegram_access_reviews WHERE chat_id=?").bind(chatId).first<{status:string;reason:string;flagged_at:string|null;deadline_at:string|null}>();
  if(row?.status==="warning"&&row.deadline_at){
   const due=await env.DB.prepare("SELECT CASE WHEN datetime(?)<=datetime('now') THEN 1 ELSE 0 END AS due").bind(row.deadline_at).first<{due:number}>();
   if(due?.due){
    await env.DB.prepare("UPDATE telegram_access_reviews SET status='restricted',updated_at=datetime('now') WHERE chat_id=? AND status='warning' AND datetime(deadline_at)<=datetime('now')").bind(chatId).run();
    row={...row,status:"restricted"};
   }
  }
  if(!row||row.status==="clear"||row.status==="cleared")return json({active:false});
  const seconds=row.deadline_at?Math.max(0,Math.floor((new Date(row.deadline_at.replace(" ","T")+"Z").getTime()-Date.now())/1000)):0;
  return json({active:true,status:row.status,reason:row.reason,deadlineAt:row.deadline_at,secondsRemaining:seconds,restricted:row.status==="restricted"});
 }catch(error){console.error("MaseNet re-verification status failed:",error instanceof Error?error.message:String(error));return json({error:"Could not load verification status."},503)}
};
