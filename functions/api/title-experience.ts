import { Env, json, cookie, sha256, currentAdmin, requireAdmin } from "./auth/_shared";

type ExperienceEnv = Env;
const validId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,180}$/.test(v);
const cleanList = (v: unknown, max = 20) => Array.isArray(v)
  ? [...new Set(v.filter((x): x is string => typeof x === "string").map(x => x.trim().slice(0,60)).filter(Boolean))].slice(0,max)
  : [];

async function ensureTables(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS title_user_events (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('view','watch','complete','skip','save')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_title_events_user_time ON title_user_events(user_id,created_at DESC)").run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_title_preferences (
    user_id TEXT PRIMARY KEY,languages_json TEXT NOT NULL DEFAULT '[]',
    genres_json TEXT NOT NULL DEFAULT '[]',updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS title_reviews (
    id TEXT PRIMARY KEY,title_id TEXT NOT NULL,user_id TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published','hidden')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(title_id,user_id)
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_title_reviews_title_status ON title_reviews(title_id,status,created_at DESC)").run();
}
async function userIdFor(request: Request, env: ExperienceEnv): Promise<string | null> {
  const admin = await currentAdmin(request,env);
  if (admin) return "admin:" + admin.id;
  const token = cookie(request,"masetv_user_session");
  if (!token) return null;
  const row = await env.DB.prepare("SELECT u.id FROM site_user_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>datetime('now')")
    .bind(await sha256(token)).first<{id:string}>();
  return row?.id || null;
}
function parseObject(raw: string): Record<string,unknown> {
  try { const v=JSON.parse(raw); return v && typeof v==="object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
export const onRequestGet: PagesFunction<ExperienceEnv> = async ({request,env}) => {
  try {
    await ensureTables(env.DB);
    const userId=await userIdFor(request,env);
    const url=new URL(request.url);
    const titleId=url.searchParams.get("titleId") || "";
    const preferences=userId ? await env.DB.prepare("SELECT languages_json,genres_json FROM user_title_preferences WHERE user_id=?").bind(userId).first<{languages_json:string;genres_json:string}>():null;
    if (titleId) {
      if (!validId(titleId)) return json({error:"Invalid title ID."},400);
      const [reviews,summary]=await Promise.all([
        env.DB.prepare("SELECT id,rating,body,created_at AS createdAt FROM title_reviews WHERE title_id=? AND status='published' ORDER BY created_at DESC LIMIT 50").bind(titleId).all<{id:string;rating:number;body:string;createdAt:string}>(),
        env.DB.prepare("SELECT COUNT(*) AS count,ROUND(AVG(rating),1) AS average FROM title_reviews WHERE title_id=? AND status='published'").bind(titleId).first<{count:number;average:number|null}>()
      ]);
      return json({reviews:reviews.results||[],reviewCount:Number(summary?.count||0),averageRating:summary?.average||null,preferences:preferences?{languages:JSON.parse(preferences.languages_json||"[]"),genres:JSON.parse(preferences.genres_json||"[]")}:{languages:[],genres:[]}});
    }
    if (!userId) return json({error:"Sign in to get recommendations based on your viewing activity."},401);
    const [events,titles]=await Promise.all([
      env.DB.prepare("SELECT title_id,event_type,created_at FROM title_user_events WHERE user_id=? ORDER BY created_at DESC LIMIT 150").bind(userId).all<{title_id:string;event_type:string;created_at:string}>(),
      env.DB.prepare("SELECT id,name,kind,metadata_json,poster_url,year FROM titles ORDER BY created_at DESC LIMIT 500").all<{id:string;name:string;kind:string;metadata_json:string;poster_url:string;year:number|null}>()
    ]);
    const seen=new Set((events.results||[]).filter(e=>e.event_type!=="skip").map(e=>e.title_id));
    const skipped=new Set((events.results||[]).filter(e=>e.event_type==="skip").map(e=>e.title_id));
    const weights=new Map<string,number>();
    for (const event of events.results||[]) {
      const row=(titles.results||[]).find(t=>t.id===event.title_id); if(!row) continue;
      const meta=parseObject(row.metadata_json);
      const genres=cleanList(meta.genres||meta.genre);
      const weight=event.event_type==="complete"?4:event.event_type==="watch"?3:event.event_type==="save"?3:1;
      for(const genre of genres) weights.set(genre.toLowerCase(),(weights.get(genre.toLowerCase())||0)+weight);
    }
    const preferred=preferences?cleanList(JSON.parse(preferences.genres_json||"[]")).map(x=>x.toLowerCase()):[];
    const languagePrefs=preferences?cleanList(JSON.parse(preferences.languages_json||"[]")).map(x=>x.toLowerCase()):[];
    const ranked=(titles.results||[]).filter(t=>!seen.has(t.id)&&!skipped.has(t.id)).map(row=>{
      const meta=parseObject(row.metadata_json);
      const genres=cleanList(meta.genres||meta.genre);
      const language=String(meta.language||meta.languages||"").toLowerCase();
      const score=genres.reduce((n,g)=>n+(weights.get(g.toLowerCase())||0)+(preferred.includes(g.toLowerCase())?5:0),0)+(languagePrefs.some(l=>language.includes(l))?4:0);
      return {id:row.id,name:row.name,type:row.kind,posterUrl:String(meta.posterUrl||row.poster_url||""),year:row.year||meta.year||"",genres,score,description:String(meta.description||"")};
    }).sort((a,b)=>b.score-a.score);
    return json({recommendations:ranked.slice(0,24),basedOnEvents:(events.results||[]).length,preferences:{languages:languagePrefs,genres:preferred}});
  } catch { return json({error:"Movie experience data is temporarily unavailable."},503); }
};
export const onRequestPost: PagesFunction<ExperienceEnv> = async ({request,env}) => {
  try {
    await ensureTables(env.DB);
    const userId=await userIdFor(request,env);
    if(!userId) return json({error:"Sign in to save your preferences, activity, or review."},401);
    const raw=await request.text(); if(raw.length>8000) return json({error:"Request is too large."},413);
    let body:Record<string,unknown>; try{body=JSON.parse(raw)}catch{return json({error:"Invalid JSON."},400)}
    const action=body.action;
    if(action==="preferences"){
      const languages=cleanList(body.languages,12),genres=cleanList(body.genres,30);
      await env.DB.prepare("INSERT INTO user_title_preferences(user_id,languages_json,genres_json,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET languages_json=excluded.languages_json,genres_json=excluded.genres_json,updated_at=datetime('now')")
        .bind(userId,JSON.stringify(languages),JSON.stringify(genres)).run();
      return json({ok:true,languages,genres});
    }
    if(action==="event"){
      if(!validId(body.titleId)) return json({error:"A valid titleId is required."},400);
      const eventType=String(body.eventType||"");
      if(!["view","watch","complete","skip","save"].includes(eventType)) return json({error:"Unsupported activity type."},400);
      const progress=Math.max(0,Math.min(100,Math.round(Number(body.progress)||0)));
      await env.DB.prepare("INSERT INTO title_user_events(id,user_id,title_id,event_type,progress) VALUES(?,?,?,?,?)")
        .bind(crypto.randomUUID(),userId,body.titleId,eventType,progress).run();
      return json({ok:true});
    }
    if(action==="review"){
      if(!validId(body.titleId)) return json({error:"A valid titleId is required."},400);
      const rating=Math.round(Number(body.rating));
      const text=typeof body.body==="string"?body.body.trim():"";
      if(!Number.isInteger(rating)||rating<1||rating>5||text.length>1500) return json({error:"Choose a 1–5 star rating and keep the review under 1,500 characters."},400);
      const title=await env.DB.prepare("SELECT id FROM titles WHERE id=?").bind(body.titleId).first<{id:string}>();
      if(!title) return json({error:"That title is no longer in the library."},404);
      await env.DB.prepare("INSERT INTO title_reviews(id,title_id,user_id,rating,body) VALUES(?,?,?,?,?) ON CONFLICT(title_id,user_id) DO UPDATE SET rating=excluded.rating,body=excluded.body,status='published',updated_at=datetime('now')")
        .bind(crypto.randomUUID(),body.titleId,userId,rating,text).run();
      return json({ok:true});
    }
    if(action==="moderateReview"){
      const gate=await requireAdmin(request,env); if(gate.response) return gate.response;
      if(!validId(body.reviewId)||!["published","hidden"].includes(String(body.status))) return json({error:"Invalid review moderation request."},400);
      await env.DB.prepare("UPDATE title_reviews SET status=?,updated_at=datetime('now') WHERE id=?").bind(body.status,body.reviewId).run();
      return json({ok:true});
    }
    return json({error:"Unsupported action."},400);
  } catch { return json({error:"Movie experience update failed. Please try again."},503); }
};
