import { json, requireAdmin } from "./auth/_shared";
interface Env { DB: D1Database; ADMIN_EMAIL?: string; }
export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
  const auth = await requireAdmin(request, env); if (auth.response) return auth.response;
  const result = await env.DB.prepare("SELECT id,message,status,created_at FROM ai_reports ORDER BY created_at DESC LIMIT 100").all<{id:string;message:string;status:string;created_at:string}>();
  return json({ reports: (result.results || []).map(r => ({ query:r.message, source:"website", count:1, status:r.status, createdAt:r.created_at, id:r.id })) });
};