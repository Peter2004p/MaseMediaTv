import { json, requireAdmin } from "../auth/_shared";

interface Env { DB: D1Database; ADMIN_EMAIL?: string; }

export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: "Admin access required" }, 401);
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_missing_searches (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, chat_type TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    const [summary, rows] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT lower(trim(query))) AS unique_queries FROM telegram_missing_searches WHERE date(created_at) = date('now')").first<{ total: number; unique_queries: number }>(),
      env.DB.prepare("SELECT query, COUNT(*) AS requests, MAX(created_at) AS last_requested FROM telegram_missing_searches WHERE date(created_at) = date('now') GROUP BY lower(trim(query)) ORDER BY requests DESC, last_requested DESC LIMIT 100").all<{ query: string; requests: number; last_requested: string }>()
    ]);
    return json({ date: new Date().toISOString().slice(0, 10), total: summary?.total || 0, uniqueQueries: summary?.unique_queries || 0, requests: rows.results || [] });
  } catch {
    return json({ error: "Could not load missing-search report." }, 500);
  }
};
