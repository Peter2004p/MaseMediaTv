import { Env, json, cookie, sha256, currentAdmin } from "./auth/_shared";

type CommentsEnv = Env;
const validVideoId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{6,20}$/.test(value);

// Match the exact identity model used by /api/profiles: admins own profiles under
// "admin:<admin-id>", while normal members own profiles under their site user ID.
async function authenticatedUser(request: Request, env: CommentsEnv): Promise<string | null> {
  const admin = await currentAdmin(request, env);
  if (admin) return "admin:" + admin.id;

  const token = cookie(request, "masetv_user_session");
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id FROM site_user_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>datetime('now')"
  ).bind(await sha256(token)).first<{id:string}>();
  return row?.id || null;
}

async function ensureTable(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS youtube_comments (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_youtube_comments_video_created ON youtube_comments(video_id,created_at)").run();
}

export const onRequestGet: PagesFunction<CommentsEnv> = async ({request,env}) => {
  try {
    await ensureTable(env.DB);
    const url = new URL(request.url);
    const videoId = url.searchParams.get("videoId") || "";
    if (!validVideoId(videoId)) return json({error:"A valid YouTube video ID is required."},400);
    const rows = await env.DB.prepare(
      "SELECT id,display_name AS displayName,avatar,body AS text,created_at AS createdAt FROM youtube_comments WHERE video_id=? ORDER BY created_at DESC,id DESC LIMIT 100"
    ).bind(videoId).all<{id:string;displayName:string;avatar:string;text:string;createdAt:string}>();
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM youtube_comments WHERE video_id=?").bind(videoId).first<{count:number}>();
    return json({videoId,count:Number(count?.count||0),comments:(rows.results||[]).reverse()});
  } catch {
    return json({error:"Comments are temporarily unavailable."},503);
  }
};

export const onRequestPost: PagesFunction<CommentsEnv> = async ({request,env}) => {
  try {
    const userId = await authenticatedUser(request,env);
    if (!userId) return json({error:"Sign in to comment with your MaseNet profile."},401);
    const raw = await request.text();
    if (raw.length > 5000) return json({error:"Comment request is too large."},413);
    let body: {videoId?:unknown;profileId?:unknown;text?:unknown};
    try { body = JSON.parse(raw) as typeof body; } catch { return json({error:"Invalid comment data."},400); }
    if (!validVideoId(body.videoId)) return json({error:"A valid video is required."},400);
    const text = typeof body.text === "string" ? body.text.trim().replace(/\\u0000/g,"") : "";
    if (!text || text.length > 1000) return json({error:"Comments must contain 1–1000 characters."},400);
    const profileId = typeof body.profileId === "string" ? body.profileId : "";
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(profileId)) return json({error:"Choose a MaseNet profile before commenting."},400);
    const profile = await env.DB.prepare(
      "SELECT p.name,p.avatar FROM user_profiles p WHERE p.id=? AND p.user_id=?"
    ).bind(profileId,userId).first<{name:string;avatar:string}>();
    if (!profile) return json({error:"That profile does not belong to your signed-in account."},403);
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM youtube_comments WHERE user_id=? AND created_at>=datetime('now','-10 seconds')"
    ).bind(userId).first<{n:number}>();
    if ((recent?.n||0) >= 3) return json({error:"Please wait a moment before posting another comment."},429);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO youtube_comments(id,video_id,user_id,profile_id,display_name,avatar,body) VALUES(?,?,?,?,?,?,?)"
    ).bind(id,String(body.videoId),userId,profileId,String(profile.name||"MaseNet member").slice(0,60),String(profile.avatar||"").slice(0,500),text).run();
    const saved = await env.DB.prepare(
      "SELECT id,display_name AS displayName,avatar,body AS text,created_at AS createdAt FROM youtube_comments WHERE id=?"
    ).bind(id).first();
    return json({ok:true,comment:saved},201);
  } catch {
    return json({error:"Your comment could not be posted. Please retry."},503);
  }
};
