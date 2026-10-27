import { Env, json, cookie, sha256, currentAdmin } from "./auth/_shared";

type LibraryPayload = {
  watchlist?: unknown;
  readNotifications?: unknown;
  progress?: unknown;
  completed?: unknown;
};
type LibraryEnv = Env;

async function resolveUser(request: Request, env: LibraryEnv): Promise<string | null> {
  const admin = await currentAdmin(request, env);
  if (admin) return "admin:" + admin.id;
  const token = cookie(request, "masetv_user_session");
  if (!token) return null;
  const user = await env.DB.prepare(
    "SELECT u.id FROM site_user_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at > datetime('now')"
  ).bind(await sha256(token)).first<{ id: string }>();
  return user?.id || null;
}

async function ensureTable(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_library_state (
    user_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}

const cleanStringArray = (value: unknown, maxItems: number, maxLength: number) =>
  Array.isArray(value)
    ? [...new Set(value.filter((x): x is string => typeof x === "string").map(x => x.slice(0, maxLength)).filter(Boolean))].slice(0, maxItems)
    : [];

function cleanProgress(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
    if (/^[A-Za-z0-9_-]{1,180}$/.test(key) && typeof raw === "number" && Number.isFinite(raw)) out[key] = Math.max(0, Math.min(100, Math.round(raw)));
  }
  return out;
}
function cleanCompleted(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
    if (/^[A-Za-z0-9_-]{1,180}$/.test(key) && typeof raw === "boolean") out[key] = raw;
  }
  return out;
}
function normalize(body: LibraryPayload) {
  return {
    watchlist: cleanStringArray(body.watchlist, 500, 180),
    readNotifications: cleanStringArray(body.readNotifications, 250, 220),
    progress: cleanProgress(body.progress),
    completed: cleanCompleted(body.completed)
  };
}

export const onRequestGet: PagesFunction<LibraryEnv> = async ({ request, env }) => {
  try {
    const userId = await resolveUser(request, env);
    if (!userId) return json({ error: "Sign in to sync your MaseNet library across devices." }, 401);
    await ensureTable(env.DB);
    const row = await env.DB.prepare("SELECT payload,updated_at FROM user_library_state WHERE user_id=?").bind(userId).first<{ payload: string; updated_at: string }>();
    let state = normalize({});
    if (row?.payload) {
      try { state = normalize(JSON.parse(row.payload) as LibraryPayload); } catch { /* ignore invalid legacy data */ }
    }
    return json({ state, updatedAt: row?.updated_at || null });
  } catch {
    return json({ error: "Your library could not be loaded right now." }, 503);
  }
};

export const onRequestPost: PagesFunction<LibraryEnv> = async ({ request, env }) => {
  try {
    const userId = await resolveUser(request, env);
    if (!userId) return json({ error: "Sign in to sync your MaseNet library across devices." }, 401);
    const raw = await request.text();
    if (raw.length > 40000) return json({ error: "Library update is too large." }, 413);
    let body: LibraryPayload;
    try { body = JSON.parse(raw) as LibraryPayload; } catch { return json({ error: "Invalid library data." }, 400); }
    const state = normalize(body);
    await ensureTable(env.DB);
    await env.DB.prepare("INSERT INTO user_library_state(user_id,payload,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload,updated_at=datetime('now')")
      .bind(userId, JSON.stringify(state)).run();
    return json({ ok: true, state });
  } catch {
    return json({ error: "Your library could not be saved right now." }, 503);
  }
};
