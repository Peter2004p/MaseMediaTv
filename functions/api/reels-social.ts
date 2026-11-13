import { Env, json, cookie, sha256, currentAdmin } from "./auth/_shared";

type SocialEnv = Env;
const validId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,180}$/.test(value);

async function resolveUser(request: Request, env: SocialEnv): Promise<string | null> {
  const admin = await currentAdmin(request, env);
  if (admin) return "admin:" + admin.id;
  const token = cookie(request, "masetv_user_session");
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id FROM site_user_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>datetime('now')"
  ).bind(await sha256(token)).first<{ id: string }>();
  return row?.id || null;
}

async function ensureTables(env: SocialEnv) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS reel_likes (reel_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (reel_id,user_id))").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_reel_likes_reel ON reel_likes(reel_id)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS reel_comments (id TEXT PRIMARY KEY, reel_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_reel_comments_reel ON reel_comments(reel_id,created_at)").run();
  try { await env.DB.prepare("ALTER TABLE reel_comments ADD COLUMN display_name TEXT NOT NULL DEFAULT 'MaseNet member'").run(); } catch {}
}

export const onRequestGet: PagesFunction<SocialEnv> = async ({ request, env }) => {
  try {
    const userId = await resolveUser(request, env);
    if (!userId) return json({ error: "Sign in to view Reel activity." }, 401);
    await ensureTables(env);
    const reelId = new URL(request.url).searchParams.get("reelId") || "";
    if (!validId(reelId)) return json({ error: "A valid reelId is required." }, 400);
    const [likes, mine, comments] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM reel_likes WHERE reel_id=?").bind(reelId).first<{ count: number }>(),
      env.DB.prepare("SELECT 1 AS liked FROM reel_likes WHERE reel_id=? AND user_id=?").bind(reelId, userId).first<{ liked: number }>(),
      env.DB.prepare("SELECT id,body AS text,display_name AS displayName,created_at AS createdAt FROM reel_comments WHERE reel_id=? ORDER BY created_at DESC LIMIT 100").bind(reelId).all<{ id: string; text: string; createdAt: string }>()
    ]);
    return json({ reelId, likes: Number(likes?.count || 0), liked: Boolean(mine), comments: (comments.results || []).reverse() });
  } catch {
    return json({ error: "Reel social data is temporarily unavailable." }, 503);
  }
};

export const onRequestPost: PagesFunction<SocialEnv> = async ({ request, env }) => {
  try {
    const userId = await resolveUser(request, env);
    if (!userId) return json({ error: "Sign in to interact with Reels." }, 401);
    const raw = await request.text();
    if (raw.length > 4000) return json({ error: "Request too large." }, 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || "{}") as Record<string, unknown>; }
    catch { return json({ error: "Invalid request body." }, 400); }
    await ensureTables(env);
    const reelId = body.reelId;
    if (!validId(reelId)) return json({ error: "A valid reelId is required." }, 400);

    if (body.action === "like") {
      const existing = await env.DB.prepare("SELECT 1 AS liked FROM reel_likes WHERE reel_id=? AND user_id=?").bind(reelId, userId).first<{ liked: number }>();
      if (existing) await env.DB.prepare("DELETE FROM reel_likes WHERE reel_id=? AND user_id=?").bind(reelId, userId).run();
      else await env.DB.prepare("INSERT OR IGNORE INTO reel_likes (reel_id,user_id) VALUES (?,?)").bind(reelId, userId).run();
      const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM reel_likes WHERE reel_id=?").bind(reelId).first<{ count: number }>();
      const mine = await env.DB.prepare("SELECT 1 AS liked FROM reel_likes WHERE reel_id=? AND user_id=?").bind(reelId, userId).first();
      return json({ liked: Boolean(mine), likes: Number(count?.count || 0) });
    }

    if (body.action === "comment") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > 1000) return json({ error: "Comments must contain 1–1000 characters." }, 400);
      const id = crypto.randomUUID();
      const displayName = "MaseNet member";
      await env.DB.prepare("INSERT INTO reel_comments (id,reel_id,user_id,body,display_name) VALUES (?,?,?,?,?)").bind(id, reelId, userId, text, displayName).run();
      const row = await env.DB.prepare("SELECT id,body AS text,display_name AS displayName,created_at AS createdAt FROM reel_comments WHERE id=?").bind(id).first<{ id: string; text: string; displayName: string; createdAt: string }>();
      return json({ comment: row }, 201);
    }
    return json({ error: "Unsupported action." }, 400);
  } catch {
    return json({ error: "Reel social data is temporarily unavailable." }, 503);
  }
};
