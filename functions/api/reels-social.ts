import { Env, json } from "./auth/_shared";

type SocialEnv = Env;
const validId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,180}$/.test(value);
async function ensureTables(env: SocialEnv) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS reel_likes (reel_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (reel_id,user_id))").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_reel_likes_reel ON reel_likes(reel_id)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS reel_comments (id TEXT PRIMARY KEY, reel_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_reel_comments_reel ON reel_comments(reel_id,created_at)").run();
}
export const onRequestGet: PagesFunction<SocialEnv> = async ({ request, env }) => {
  try {
    await ensureTables(env);
    const url = new URL(request.url);
    const reelId = url.searchParams.get("reelId") || "";
    const userId = url.searchParams.get("userId") || "";
    if (!validId(reelId) || !validId(userId)) return json({ error: "A valid reelId and userId are required." }, 400);
    const [likes, mine, comments] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM reel_likes WHERE reel_id=?").bind(reelId).first<{count:number}>(),
      env.DB.prepare("SELECT 1 AS liked FROM reel_likes WHERE reel_id=? AND user_id=?").bind(reelId,userId).first<{liked:number}>(),
      env.DB.prepare("SELECT id,body AS text,created_at AS createdAt FROM reel_comments WHERE reel_id=? ORDER BY created_at DESC LIMIT 100").bind(reelId).all<{id:string;text:string;createdAt:string}>()
    ]);
    return json({ reelId, likes: Number(likes?.count || 0), liked: Boolean(mine), comments: (comments.results || []).reverse() });
  } catch { return json({ error: "Reel social data is temporarily unavailable." }, 503); }
};
export const onRequestPost: PagesFunction<SocialEnv> = async ({ request, env }) => {
  try {
    await ensureTables(env);
    const body = await request.json() as Record<string, unknown>;
    const reelId = body.reelId, userId = body.userId, action = body.action;
    if (!validId(reelId) || !validId(userId)) return json({ error: "A valid reelId and userId are required." }, 400);
    if (action === "like") {
      const existing = await env.DB.prepare("SELECT 1 AS liked FROM reel_likes WHERE reel_id=? AND user_id=?").bind(reelId,userId).first<{liked:number}>();
      if (existing) await env.DB.prepare("DELETE FROM reel_likes WHERE reel_id=? AND user_id=?").bind(reelId,userId).run();
      else await env.DB.prepare("INSERT OR IGNORE INTO reel_likes (reel_id,user_id) VALUES (?,?)").bind(reelId,userId).run();
      const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM reel_likes WHERE reel_id=?").bind(reelId).first<{count:number}>();
      return json({ liked: !existing, likes: Number(count?.count || 0) });
    }
    if (action === "comment") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > 1000) return json({ error: "Comments must contain 1–1000 characters." }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO reel_comments (id,reel_id,user_id,body) VALUES (?,?,?,?)").bind(id,reelId,userId,text).run();
      const row = await env.DB.prepare("SELECT id,body AS text,created_at AS createdAt FROM reel_comments WHERE id=?").bind(id).first<{id:string;text:string;createdAt:string}>();
      return json({ comment: row }, 201);
    }
    return json({ error: "Unsupported action." }, 400);
  } catch { return json({ error: "Reel social data is temporarily unavailable." }, 503); }
};
