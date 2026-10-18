import { Env, json, requireAdmin } from "./auth/_shared";
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const row = await env.DB.prepare("SELECT value_json FROM site_settings WHERE key='homepage_rows'").first<{value_json:string}>();
  try { return json({ rows: row ? JSON.parse(row.value_json) : ["continue","myList","latestMovies","latestDramas"] }); }
  catch { return json({ rows: ["continue","myList","latestMovies","latestDramas"] }); }
};
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const body = await request.json() as { rows?: unknown };
  if (!Array.isArray(body.rows) || !body.rows.every(x => typeof x === "string")) return json({ error: "Rows must be a list of section names." }, 400);
  await env.DB.prepare("INSERT INTO site_settings (key,value_json,updated_at) VALUES ('homepage_rows',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=datetime('now')").bind(JSON.stringify(body.rows)).run();
  return json({ rows: body.rows });
};
