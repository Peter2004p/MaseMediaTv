import { Env, json, requireAdmin } from "./auth/_shared";
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const row = await env.DB.prepare("SELECT value_json FROM site_settings WHERE key='site_theme'").first<{value_json:string}>();
  try { return json(row ? JSON.parse(row.value_json) : { theme: "dark" }); } catch { return json({ theme: "dark" }); }
};
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const body = await request.json() as { theme?: unknown };
  if (typeof body.theme !== "string" || body.theme.length > 40) return json({ error: "Invalid theme." }, 400);
  await env.DB.prepare("INSERT INTO site_settings (key,value_json,updated_at) VALUES ('site_theme',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=datetime('now')").bind(JSON.stringify({theme:body.theme})).run();
  return json({ theme: body.theme });
};
