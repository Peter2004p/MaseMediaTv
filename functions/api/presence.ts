import type { Env } from "./auth/_shared";

type PresenceEnv = Env & { DB: D1Database };

export const onRequestGet = async ({ env }: { env: PresenceEnv }) => {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS analytics_presence (
      session_key TEXT PRIMARY KEY,
      route TEXT NOT NULL DEFAULT '/',
      last_seen TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
    await env.DB.prepare("DELETE FROM analytics_presence WHERE last_seen < datetime('now','-10 minutes')").run();
    const result = await env.DB.prepare("SELECT COUNT(*) AS count FROM analytics_presence WHERE last_seen >= datetime('now','-90 seconds')").first<{count:number}>();
    return Response.json({ ok:true, online:Number(result?.count||0), windowSeconds:90 }, { headers:{ "Cache-Control":"no-store, max-age=0" } });
  } catch (error) {
    console.error("MaseNet live presence unavailable", error instanceof Error ? error.message : "unknown error");
    return Response.json({ ok:false, online:null }, { status:503, headers:{ "Cache-Control":"no-store" } });
  }
};
