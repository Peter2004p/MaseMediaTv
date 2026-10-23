import { json, requireAdmin } from "./auth/_shared";
interface Env { DB: D1Database; ADMIN_EMAIL?: string; }
export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
  const auth = await requireAdmin(request, env); if (auth.response) return auth.response;
  const website = await env.DB.prepare("SELECT id,message,status,created_at FROM ai_reports ORDER BY created_at DESC LIMIT 100").all<{id:string;message:string;status:string;created_at:string}>();
  let telegram: {query:string;source:string;count:number;createdAt:string}[] = [];
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_missing_searches (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, chat_type TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    const rows = await env.DB.prepare("SELECT lower(trim(query)) AS normalized, MIN(query) AS query, COUNT(*) AS count, MAX(created_at) AS created_at FROM telegram_missing_searches GROUP BY lower(trim(query)) ORDER BY created_at DESC LIMIT 100").all<{normalized:string;query:string;count:number;created_at:string}>();
    telegram = (rows.results || []).map(r => ({query:r.query,source:"telegram",count:r.count,createdAt:r.created_at}));
  } catch { /* Telegram report table may not exist until first bot search. */ }
  const reports = [
    ...(website.results || []).map(r => ({query:r.message,source:"website",count:1,status:r.status,createdAt:r.created_at,id:r.id})),
    ...telegram
  ].sort((a,b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0,100);
  return json({ reports });
};
