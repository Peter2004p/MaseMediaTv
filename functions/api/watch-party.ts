import { Env, json, cookie, sha256, currentAdmin } from "./auth/_shared";
type WatchEnv=Env;
async function resolveUser(request:Request,env:WatchEnv):Promise<string|null>{
 const admin=await currentAdmin(request,env); if(admin)return "admin:"+admin.id;
 const token=cookie(request,"masetv_user_session"); if(!token)return null;
 const row=await env.DB.prepare("SELECT u.id FROM site_user_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>datetime('now')").bind(await sha256(token)).first<{id:string}>();
 return row?.id||null;
}
async function ensure(db:D1Database){
 await db.prepare(`CREATE TABLE IF NOT EXISTS watch_party_rooms(
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, host_user_id TEXT NOT NULL, title_id TEXT NOT NULL,
  episode_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', is_private INTEGER NOT NULL DEFAULT 1,
  current_time REAL NOT NULL DEFAULT 0, is_playing INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
 )`).run();
 await db.prepare(`CREATE TABLE IF NOT EXISTS watch_party_members(
  room_id TEXT NOT NULL REFERENCES watch_party_rooms(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT 'Viewer', is_host INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')), joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(room_id,user_id)
 )`).run();
 await db.prepare("CREATE INDEX IF NOT EXISTS idx_watch_party_active ON watch_party_rooms(status,expires_at)").run();
}
const code=()=>{const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";const bytes=new Uint8Array(6);crypto.getRandomValues(bytes);return [...bytes].map(b=>chars[b%chars.length]).join("")};
export const onRequestGet:PagesFunction<WatchEnv>=async({request,env})=>{
 try{
  const userId=await resolveUser(request,env);if(!userId)return json({error:"Sign in to use Watch Party."},401);
  await ensure(env.DB);const url=new URL(request.url),roomId=url.searchParams.get("room")||"",codeValue=url.searchParams.get("code")||"";
  const mine=await env.DB.prepare("SELECT r.id,r.code,r.title_id,r.episode_id,r.status,r.host_user_id,r.current_time,r.is_playing,r.revision,r.updated_at,m.is_host FROM watch_party_members m JOIN watch_party_rooms r ON r.id=m.room_id WHERE m.user_id=? AND r.status='active' AND r.expires_at>datetime('now') ORDER BY r.updated_at DESC LIMIT 1").bind(userId).first<any>();
  const room=roomId||codeValue?await env.DB.prepare("SELECT * FROM watch_party_rooms WHERE "+(roomId?"id=?":"code=?")+" AND status='active' AND expires_at>datetime('now')").bind(roomId||codeValue).first<any>():mine;
  if(!room)return json({room:null});
  const member=await env.DB.prepare("SELECT 1 AS ok FROM watch_party_members WHERE room_id=? AND user_id=?").bind(room.id,userId).first();
  if(!member)return json({error:"You are not a member of this Watch Party."},403);
  await env.DB.prepare("UPDATE watch_party_members SET last_seen_at=datetime('now') WHERE room_id=? AND user_id=?").bind(room.id,userId).run();
  const members=await env.DB.prepare("SELECT user_id,display_name,is_host,last_seen_at FROM watch_party_members WHERE room_id=? ORDER BY is_host DESC,joined_at").bind(room.id).all();
  return json({room:{id:room.id,code:room.code,titleId:room.title_id,episodeId:room.episode_id,status:room.status,hostUserId:room.host_user_id,currentTime:room.current_time,isPlaying:!!room.is_playing,revision:room.revision,updatedAt:room.updated_at},members:members.results||[],viewerId:userId});
 }catch{return json({error:"Watch Party could not be loaded."},503)}
};
export const onRequestPost:PagesFunction<WatchEnv>=async({request,env})=>{
 try{
  const userId=await resolveUser(request,env);if(!userId)return json({error:"Sign in to use Watch Party."},401);
  const raw=await request.text();if(raw.length>5000)return json({error:"Request too large."},413);
  const body=JSON.parse(raw||"{}") as any;await ensure(env.DB);
  if(body.action==="create"){
   const titleId=String(body.titleId||"").slice(0,180),episodeId=String(body.episodeId||"").slice(0,180);
   if(!/^[A-Za-z0-9_-]{1,180}$/.test(titleId)|| (episodeId&&!/^[A-Za-z0-9_-]{1,180}$/.test(episodeId)))return json({error:"Choose a valid title and episode."},400);
   const existing=await env.DB.prepare("SELECT id FROM watch_party_members m JOIN watch_party_rooms r ON r.id=m.room_id WHERE m.user_id=? AND r.status='active' AND r.expires_at>datetime('now')").bind(userId).first();
   if(existing)return json({error:"Leave your current Watch Party before creating another."},409);
   const id=crypto.randomUUID().replace(/-/g,"");let roomCode="";
   for(let i=0;i<5;i++){const candidate=code();try{await env.DB.prepare("INSERT INTO watch_party_rooms(id,code,host_user_id,title_id,episode_id,expires_at) VALUES(?,?,?,?,?,datetime('now','+6 hours'))").bind(id,candidate,userId,titleId,episodeId).run();roomCode=candidate;break}catch{}}
   if(!roomCode)return json({error:"Could not reserve a room code. Retry."},503);
   const name=String(body.displayName||"Viewer").slice(0,40);
   await env.DB.prepare("INSERT INTO watch_party_members(room_id,user_id,display_name,is_host) VALUES(?,?,?,1)").bind(id,userId,name).run();
   return json({ok:true,room:{id,code:roomCode,titleId,episodeId,hostUserId:userId,currentTime:0,isPlaying:false,revision:0},viewerId:userId});
  }
  if(body.action==="join"){
   const roomCode=String(body.code||"").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6);
   const room=await env.DB.prepare("SELECT * FROM watch_party_rooms WHERE code=? AND status='active' AND expires_at>datetime('now')").bind(roomCode).first<any>();
   if(!room)return json({error:"That Watch Party code is invalid or expired."},404);
   const current=await env.DB.prepare("SELECT room_id FROM watch_party_members m JOIN watch_party_rooms r ON r.id=m.room_id WHERE m.user_id=? AND r.status='active' AND r.expires_at>datetime('now')").bind(userId).first<{room_id:string}>();
   if(current&&current.room_id!==room.id)return json({error:"Leave your current Watch Party before joining another."},409);
   await env.DB.prepare("INSERT INTO watch_party_members(room_id,user_id,display_name) VALUES(?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET last_seen_at=datetime('now')").bind(room.id,userId,String(body.displayName||"Viewer").slice(0,40)).run();
   return json({ok:true,room:{id:room.id,code:room.code,titleId:room.title_id,episodeId:room.episode_id,hostUserId:room.host_user_id,currentTime:room.current_time,isPlaying:!!room.is_playing,revision:room.revision},viewerId:userId});
  }
  const roomId=String(body.roomId||"");
  const membership=await env.DB.prepare("SELECT m.is_host,r.host_user_id FROM watch_party_members m JOIN watch_party_rooms r ON r.id=m.room_id WHERE m.room_id=? AND m.user_id=? AND r.status='active'").bind(roomId,userId).first<{is_host:number;host_user_id:string}>();
  if(!membership)return json({error:"You are not in this Watch Party."},403);
  if(body.action==="leave"){
   await env.DB.prepare("DELETE FROM watch_party_members WHERE room_id=? AND user_id=?").bind(roomId,userId).run();
   if(membership.is_host)await env.DB.prepare("UPDATE watch_party_rooms SET status='ended',updated_at=datetime('now') WHERE id=?").bind(roomId).run();
   return json({ok:true});
  }
  if(body.action==="sync"){
   if(!membership.is_host)return json({error:"Only the host can control synchronized playback."},403);
   const currentTime=Math.max(0,Math.min(86400,Number(body.currentTime)||0));
   const isPlaying=!!body.isPlaying;
   const episodeId=String(body.episodeId||"").slice(0,180);
   await env.DB.prepare("UPDATE watch_party_rooms SET current_time=?,is_playing=?,episode_id=CASE WHEN ?='' THEN episode_id ELSE ? END,revision=revision+1,updated_at=datetime('now') WHERE id=?")
    .bind(currentTime,isPlaying?1:0,episodeId,episodeId,roomId).run();
   return json({ok:true});
  }
  if(body.action==="end"){
   if(!membership.is_host)return json({error:"Only the host can end this Watch Party."},403);
   await env.DB.prepare("UPDATE watch_party_rooms SET status='ended',updated_at=datetime('now') WHERE id=?").bind(roomId).run();
   return json({ok:true});
  }
  return json({error:"Unknown Watch Party action."},400);
 }catch{return json({error:"Watch Party action failed. Retry shortly."},503)}
};
