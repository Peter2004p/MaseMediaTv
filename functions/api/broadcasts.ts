import { Env, json, requireAdmin } from "./auth/_shared";
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rows = await env.DB.prepare("SELECT id,title,description,media_url,target,expires_at,created_at FROM broadcasts WHERE expires_at IS NULL OR expires_at > datetime('now') ORDER BY created_at DESC").all<Record<string,unknown>>();
  const posts = (rows.results || []).map(r => ({ id:r.id, mediaType: String(r.media_url||"").match(/\.(mp4|webm|mov)(\?|$)/i) ? "video" : "image", mediaUrl:r.media_url, caption:r.description, destination:r.target, expiresAt:r.expires_at, createdAt:r.created_at }));
  return json({ posts });
};
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const body = await request.json() as Record<string,unknown>;
  const id = crypto.randomUUID(), title = typeof body.title === "string" ? body.title : "";
  const description = typeof body.caption === "string" ? body.caption : typeof body.description === "string" ? body.description : "";
  const mediaUrl = typeof body.mediaUrl === "string" ? body.mediaUrl : "";
  const target = ["website","telegram","both"].includes(String(body.destination)) ? String(body.destination) : "website";
  const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : null;
  if (!mediaUrl || !/^https:\/\//i.test(mediaUrl)) return json({ error: "A valid HTTPS media URL is required." }, 400);
  await env.DB.prepare("INSERT INTO broadcasts (id,title,description,media_url,target,expires_at) VALUES (?,?,?,?,?,?)").bind(id,title,description,mediaUrl,target,expiresAt).run();
  return json({ post:{id,mediaType:/\.(mp4|webm|mov)(\?|$)/i.test(mediaUrl)?"video":"image",mediaUrl,caption:description,destination:target,expiresAt,createdAt:new Date().toISOString()} },201);
};
