const COOKIE = "masenet_admin";
const TYPES = new Set(["Movie", "Drama", "Episode", "Reel"]);
function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });
}
function getCookie(request) {
  const raw = request.headers.get("Cookie") || "";
  const match = raw.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]*)"));
  return match ? match[1] : "";
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function authenticated(request, env) {
  const token = getCookie(request);
  if (!/^[a-f0-9]{64}$/i.test(token)) return false;
  const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ? LIMIT 1").bind(await sha256(token)).first();
  return !!row && Number(row.expires_at) > Math.floor(Date.now() / 1000);
}
function text(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }
function validHttps(v, optional = false) {
  if (optional && (v == null || v === "")) return true;
  if (typeof v !== "string" || v.length > 2048) return false;
  try { const u = new URL(v); return u.protocol === "https:" && !!u.hostname; } catch { return false; }
}
export async function onRequest({ request, env, params }) {
  if (!env.DB) return json({ error: "Database binding DB is not configured." }, 503);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Request origin rejected." }, 403);
  try { if (!await authenticated(request, env)) return json({ error: "Admin authentication required." }, 401); }
  catch { return json({ error: "Authentication check failed." }, 503); }
  const id = text(params?.id, 100);
  if (!id) return json({ error: "Catalog item ID is required." }, 400);
  if (request.method === "DELETE") {
    try {
      const result = await env.DB.prepare("DELETE FROM catalog WHERE id = ?").bind(id).run();
      return result.meta?.changes ? json({ ok: true, id }) : json({ error: "Catalog item not found." }, 404);
    } catch { return json({ error: "Could not delete catalog item." }, 500); }
  }
  if (request.method !== "PATCH" && request.method !== "PUT") {
    return json({ error: "Method not allowed." }, 405);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Request must contain valid JSON." }, 400); }
  const type = text(body?.type, 30);
  const title = text(body?.title, 200);
  const videoUrl = text(body?.video_url, 2048);
  const subtitleUrl = text(body?.subtitle_url, 2048);
  if (!TYPES.has(type)) return json({ error: "Unsupported content type." }, 400);
  if (!title) return json({ error: "Title is required." }, 400);
  if (!validHttps(videoUrl)) return json({ error: "A valid HTTPS media URL is required." }, 400);
  if (!validHttps(subtitleUrl, true)) return json({ error: "Subtitle URL must be HTTPS." }, 400);
  const yearRaw = body?.year == null || body.year === "" ? null : Number(body.year);
  if (yearRaw !== null && (!Number.isInteger(yearRaw) || yearRaw < 1888 || yearRaw > new Date().getUTCFullYear() + 5)) return json({ error: "Release year is invalid." }, 400);
  const epRaw = body?.episode_number == null || body.episode_number === "" ? null : Number(body.episode_number);
  if (epRaw !== null && (!Number.isInteger(epRaw) || epRaw < 1 || epRaw > 10000)) return json({ error: "Episode number is invalid." }, 400);
  try {
    const result = await env.DB.prepare("UPDATE catalog SET type=?,title=?,description=?,poster=?,category=?,year=?,rating=?,video_url=?,subtitle_url=?,episode_of=?,episode_number=? WHERE id=?")
      .bind(type,title,text(body.description,5000),text(body.poster,2048),text(body.category,100),yearRaw,text(body.rating,20),videoUrl,subtitleUrl || null,text(body.episode_of,200) || null,epRaw,id).run();
    return result.meta?.changes ? json({ ok: true, id }) : json({ error: "Catalog item not found or unchanged." }, 404);
  } catch { return json({ error: "Could not update catalog item." }, 500); }
}
