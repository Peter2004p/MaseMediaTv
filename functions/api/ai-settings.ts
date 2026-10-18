import { json, requireAdmin } from "./auth/_shared";
interface Env { DB: D1Database; ADMIN_EMAIL?: string; }
export const onRequestGet = async ({ env }: { env: Env }) => {
  const row = await env.DB.prepare("SELECT value_json FROM site_settings WHERE key='ai_instructions'").first<{value_json:string}>();
  let instructions = "";
  try { instructions = row ? String(JSON.parse(row.value_json).instructions || "") : ""; } catch {}
  return json({ instructions });
};
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const auth = await requireAdmin(request, env); if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({})) as { instructions?: unknown };
  const instructions = String(body.instructions || "").slice(0, 8000);
  await env.DB.prepare("INSERT INTO site_settings(key,value_json,updated_at) VALUES('ai_instructions',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=datetime('now')")
    .bind(JSON.stringify({ instructions })).run();
  return json({ ok: true, instructions });
};