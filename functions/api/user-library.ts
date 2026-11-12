import { Env, json, cookie, sha256, currentAdmin } from "./auth/_shared";

type LibraryPayload = {
  watchlist?: unknown;
  readNotifications?: unknown;
  progress?: unknown;
  positions?: unknown;
  lastEpisodes?: unknown;
  completed?: unknown;
  followed?: unknown;
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

async function ensureTable(db: D1Database, userId: string) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_library_state (
    user_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_profiles (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,avatar TEXT NOT NULL DEFAULT '',is_kids INTEGER NOT NULL DEFAULT 0,pin_hash TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now')),UNIQUE(user_id,name))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS profile_library_state (profile_id TEXT PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,payload TEXT NOT NULL DEFAULT '{}',updated_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  const defaultId=(await sha256("masenet-profile-default:"+userId)).slice(0,32);
  await db.prepare("INSERT OR IGNORE INTO user_profiles(id,user_id,name,avatar,is_kids) VALUES(?,?,'Main profile','',0)").bind(defaultId,userId).run();
  const legacy=await db.prepare("SELECT payload FROM user_library_state WHERE user_id=?").bind(userId).first<{payload:string}>();
  if(legacy?.payload) await db.prepare("INSERT OR IGNORE INTO profile_library_state(profile_id,payload) VALUES(?,?)").bind(defaultId,legacy.payload).run();
 await db.prepare(`CREATE TABLE IF NOT EXISTS profile_unlocks (
  profile_id TEXT NOT NULL,user_id TEXT NOT NULL,token_hash TEXT NOT NULL,expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),PRIMARY KEY(profile_id,user_id,token_hash)
 )`).run();
  return defaultId;
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
function cleanPositions(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 1000)) {
    if (/^[A-Za-z0-9_-]{1,180}$/.test(key) && typeof raw === 'number' && Number.isFinite(raw)) out[key] = Math.max(0, Math.min(86400, Math.floor(raw)));
  }
  return out;
}
function cleanLastEpisodes(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
    if (/^[A-Za-z0-9_-]{1,180}$/.test(key) && typeof raw === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(raw)) out[key] = raw;
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
    positions: cleanPositions(body.positions),
    lastEpisodes: cleanLastEpisodes(body.lastEpisodes),
    completed: cleanCompleted(body.completed),
    followed: cleanStringArray(body.followed, 500, 180)
  };
}

export const onRequestGet: PagesFunction<LibraryEnv> = async ({ request, env }) => {
  try {
    const userId = await resolveUser(request, env);
    if (!userId) return json({ error: "Sign in to sync your MaseNet library across devices." }, 401);
    const defaultId = await ensureTable(env.DB,userId);
    const requested = new URL(request.url).searchParams.get("profileId") || defaultId;
    const owned = await env.DB.prepare("SELECT id FROM user_profiles WHERE id=? AND user_id=?").bind(requested,userId).first();
    if(!owned)return json({error:"Selected profile does not belong to this account."},403);
    const protectedProfile=await env.DB.prepare("SELECT pin_hash FROM user_profiles WHERE id=? AND user_id=?").bind(requested,userId).first<{pin_hash:string|null}>();
    if(protectedProfile?.pin_hash){
      const unlock=request.headers.get("X-MaseNet-Profile-Unlock")||"";
      const valid=unlock?await env.DB.prepare("SELECT 1 AS ok FROM profile_unlocks WHERE profile_id=? AND user_id=? AND token_hash=? AND expires_at>datetime('now')").bind(requested,userId,await sha256(unlock)).first():null;
      if(!valid)return json({error:"Unlock this profile with its PIN to access its private library."},423);
    }
    const row = await env.DB.prepare("SELECT payload,updated_at FROM profile_library_state WHERE profile_id=?").bind(requested).first<{ payload: string; updated_at: string }>();
    let state = normalize({});
    if (row?.payload) {
      try { state = normalize(JSON.parse(row.payload) as LibraryPayload); } catch { /* ignore invalid legacy data */ }
    }
    return json({ state, profileId: requested, updatedAt: row?.updated_at || null });
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
    const defaultId = await ensureTable(env.DB,userId);
    const profileId = String((body as LibraryPayload & {profileId?:string}).profileId || defaultId);
    const owned = await env.DB.prepare("SELECT id FROM user_profiles WHERE id=? AND user_id=?").bind(profileId,userId).first();
    if(!owned)return json({error:"Selected profile does not belong to this account."},403);
    const protectedProfile=await env.DB.prepare("SELECT pin_hash FROM user_profiles WHERE id=? AND user_id=?").bind(profileId,userId).first<{pin_hash:string|null}>();
    if(protectedProfile?.pin_hash){
      const unlock=request.headers.get("X-MaseNet-Profile-Unlock")||"";
      const valid=unlock?await env.DB.prepare("SELECT 1 AS ok FROM profile_unlocks WHERE profile_id=? AND user_id=? AND token_hash=? AND expires_at>datetime('now')").bind(profileId,userId,await sha256(unlock)).first():null;
      if(!valid)return json({error:"Unlock this profile with its PIN to change its private library."},423);
    }
    const existing = await env.DB.prepare("SELECT payload FROM profile_library_state WHERE profile_id=?").bind(profileId).first<{ payload: string }>();
    let previous: LibraryPayload = {};
    if (existing?.payload) { try { previous = JSON.parse(existing.payload) as LibraryPayload; } catch { previous = {}; } }
    const state = normalize({ ...previous, ...body });
    await env.DB.prepare("INSERT INTO profile_library_state(profile_id,payload,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(profile_id) DO UPDATE SET payload=excluded.payload,updated_at=datetime('now')")
      .bind(profileId, JSON.stringify(state)).run();
    return json({ ok: true, state, profileId });
  } catch {
    return json({ error: "Your library could not be saved right now." }, 503);
  }
};
