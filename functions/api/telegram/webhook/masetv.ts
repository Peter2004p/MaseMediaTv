import { json } from "../../auth/_shared";
interface Env { DB: D1Database; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_WEBHOOK_SECRET?: string; }
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok:false, error:"Bot token not configured" }, 503);
  if (!env.TELEGRAM_WEBHOOK_SECRET) return json({ ok:false, error:"Webhook secret is not configured" }, 503);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ ok:false }, 401);
  const update = await request.json().catch(() => ({})) as any;
  const msg = update.message || update.edited_message;
  const chatId = msg?.chat?.id;
  const text = String(msg?.text || "").trim();
  if (!chatId || !text) return json({ ok:true });
  const query = text.replace(/^\/start(?:\s+\S+)?/i,"").replace(/^\/search\s*/i,"").trim();
  let reply = "Welcome to MaseTv! Send a movie or drama title to search the library.";
  if (query) {
    const result = await env.DB.prepare("SELECT name,kind,year,description FROM titles WHERE name LIKE ? OR description LIKE ? ORDER BY created_at DESC LIMIT 5")
      .bind("%"+query.slice(0,100)+"%","%"+query.slice(0,100)+"%").all<{name:string;kind:string;year:number|null;description:string}>();
    const rows = result.results || [];
    reply = rows.length ? "MaseTv search results:\n" + rows.map(t=>"• "+t.name+(t.year?" ("+t.year+")":"")+" — "+t.kind).join("\n") : "I couldn't find that title in the Cloudflare MaseTv library yet. Try a shorter title or check again later.";
  }
  await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/sendMessage", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({chat_id:chatId,text:reply,disable_web_page_preview:true}) });
  return json({ ok:true });
};