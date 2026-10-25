import { json, requireAdmin, type Env } from "./auth/_shared";

type AnalyticsEnv = Env & { DB: D1Database };

async function ensureTable(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    item_id TEXT,
    item_name TEXT,
    session_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type, created_at)").run();
}

export const onRequestPost = async ({ request, env }: { request: Request; env: AnalyticsEnv }) => {
  const body = await request.json().catch(() => ({})) as { event?: unknown; itemId?: unknown; itemName?: unknown };
  const allowed = new Set(["page_view", "title_view", "search", "feedback"]);
  const event = String(body.event || "");
  if (!allowed.has(event)) return json({ error: "Unsupported analytics event" }, 400);
  const itemId = typeof body.itemId === "string" ? body.itemId.slice(0, 120) : null;
  const itemName = typeof body.itemName === "string" ? body.itemName.trim().slice(0, 160) : null;
  // Store a short-lived anonymous browser identifier only; do not store IP addresses,
  // raw search text, email addresses, or other directly identifying information.
  const cookieName = "masenet_analytics";
  let session = (request.headers.get("Cookie") || "").split(";").map(x => x.trim()).find(x => x.startsWith(cookieName + "="))?.split("=").slice(1).join("=") || "";
  let newCookie = false;
  if (!/^[a-f0-9]{32}$/.test(session)) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    session = [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
    newCookie = true;
  }
  try {
    await ensureTable(env.DB);
    // Deduplicate noisy page-view events for the same anonymous browser and route.
    if (event === "page_view" || event === "title_view") {
      const exists = await env.DB.prepare("SELECT id FROM analytics_events WHERE event_type=? AND session_key=? AND COALESCE(item_id,'')=COALESCE(?,'') AND created_at >= datetime('now','-30 minutes') LIMIT 1")
        .bind(event, session, itemId).first<{id:number}>();
      if (exists) {
        const response = json({ ok: true, recorded: false });
        if (newCookie) response.headers.append("Set-Cookie", cookieName + "=" + session + "; Max-Age=2592000; Path=/; Secure; SameSite=Lax; HttpOnly");
        return response;
      }
    }
    await env.DB.prepare("INSERT INTO analytics_events(event_type,item_id,item_name,session_key) VALUES(?,?,?,?)")
      .bind(event, itemId, itemName, session).run();
    const response = json({ ok: true, recorded: true });
    if (newCookie) response.headers.append("Set-Cookie", cookieName + "=" + session + "; Max-Age=2592000; Path=/; Secure; SameSite=Lax; HttpOnly");
    return response;
  } catch (error) {
    console.error("Analytics event could not be recorded", error instanceof Error ? error.message : "unknown error");
    return json({ error: "Analytics temporarily unavailable" }, 503);
  }
};

export const onRequestGet = async ({ request, env }: { request: Request; env: AnalyticsEnv }) => {
  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;
  try {
    await ensureTable(env.DB);
    const [totals, daily, popular, searches, feedback] = await Promise.all([
      env.DB.prepare("SELECT COUNT(DISTINCT session_key) AS visitors, SUM(CASE WHEN event_type='page_view' THEN 1 ELSE 0 END) AS page_views, SUM(CASE WHEN event_type='title_view' THEN 1 ELSE 0 END) AS title_views, SUM(CASE WHEN event_type='search' THEN 1 ELSE 0 END) AS searches, SUM(CASE WHEN event_type='feedback' THEN 1 ELSE 0 END) AS feedback FROM analytics_events").first(),
      env.DB.prepare("SELECT date(created_at) AS day, COUNT(*) AS events, COUNT(DISTINCT session_key) AS visitors FROM analytics_events WHERE created_at >= datetime('now','-6 days') GROUP BY date(created_at) ORDER BY day").all(),
      env.DB.prepare("SELECT item_id AS id,item_name AS name,COUNT(*) AS views FROM analytics_events WHERE event_type='title_view' AND item_name IS NOT NULL GROUP BY item_id,item_name ORDER BY views DESC LIMIT 8").all(),
      env.DB.prepare("SELECT item_name AS query,COUNT(*) AS count FROM analytics_events WHERE event_type='search' AND item_name IS NOT NULL GROUP BY item_name ORDER BY count DESC LIMIT 8").all(),
      env.DB.prepare("SELECT item_name AS rating,COUNT(*) AS count FROM analytics_events WHERE event_type='feedback' AND item_name IS NOT NULL GROUP BY item_name ORDER BY count DESC LIMIT 8").all()
    ]);
    return json({ totals: totals || {}, daily: daily.results || [], popular: popular.results || [], searches: searches.results || [], feedback: feedback.results || [], generatedAt: new Date().toISOString(), note: "Counts include only events recorded since analytics collection was enabled. They are not historical totals." });
  } catch (error) {
    console.error("Analytics summary failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: "Analytics summary unavailable" }, 503);
  }
};
