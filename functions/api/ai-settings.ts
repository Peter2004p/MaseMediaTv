import { json, requireAdmin } from "./auth/_shared";
interface Env { DB: D1Database; ADMIN_EMAIL?: string; }
type Appearance = { style:string; panelSize:string; buttonSize:string; avatar:string; motion:string; shape:string; effect:string };
const defaults: Appearance = { style:"glass", panelSize:"compact", buttonSize:"small", avatar:"spark", motion:"float", shape:"glass", effect:"bubbles" };
const allowed: Record<string,string[]> = {
 style:["gold","glass","neon","minimal","aurora","ocean","candy"],
 panelSize:["compact","comfortable","large"], buttonSize:["small","medium","large"],
 avatar:["spark","robot","cat","panda","moon","bubble"], motion:["float","orbit","pulse","still"],
 shape:["glass","orb","cloud","star"], effect:["bubbles","sparkles","none"]
};
export const onRequestGet = async ({ env }: { env: Env }) => {
  const rows = await env.DB.prepare("SELECT key,value_json FROM site_settings WHERE key IN ('ai_instructions','ai_appearance')").all<{key:string;value_json:string}>();
  let instructions = ""; let appearance = {...defaults};
  for (const row of rows.results || []) {
    try {
      const data = JSON.parse(row.value_json);
      if (row.key === "ai_instructions") instructions = String(data.instructions || "");
      if (row.key === "ai_appearance" && data && typeof data === "object") {
        for (const key of Object.keys(allowed) as (keyof Appearance)[]) if (allowed[key].includes(data[key])) appearance[key] = data[key];
      }
    } catch {}
  }
  return json({ instructions, settings: appearance });
};
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const auth = await requireAdmin(request, env); if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({})) as { instructions?: unknown; settings?: Partial<Appearance> };
  if (body.instructions !== undefined) {
    const instructions = String(body.instructions || "").slice(0, 8000);
    await env.DB.prepare("INSERT INTO site_settings(key,value_json,updated_at) VALUES('ai_instructions',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=datetime('now')")
      .bind(JSON.stringify({ instructions })).run();
  }
  if (body.settings !== undefined) {
    const settings = body.settings;
    if (!settings || typeof settings !== "object" || Object.entries(settings).some(([key,value])=>!(key in allowed)||typeof value!=="string"||!allowed[key].includes(value)))
      return json({ error:"One or more AI appearance settings are invalid." },400);
    const previous = await env.DB.prepare("SELECT value_json FROM site_settings WHERE key='ai_appearance'").first<{value_json:string}>();
    let merged = {...defaults};
    try { if (previous) merged = {...merged,...JSON.parse(previous.value_json)}; } catch {}
    merged = {...merged,...settings};
    await env.DB.prepare("INSERT INTO site_settings(key,value_json,updated_at) VALUES('ai_appearance',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=datetime('now')")
      .bind(JSON.stringify(merged)).run();
  }
  const row = await env.DB.prepare("SELECT value_json FROM site_settings WHERE key='ai_instructions'").first<{value_json:string}>();
  let instructions = ""; try { instructions = row ? String(JSON.parse(row.value_json).instructions || "") : ""; } catch {}
  return json({ ok:true, instructions });
};