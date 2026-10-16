const COOKIE = "masenet_admin";
function json(body, status = 200) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": "application/json; charset=utf-8"
  }});
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
async function isAdmin(request, env) {
  const token = getCookie(request);
  if (!/^[a-f0-9]{64}$/i.test(token)) return false;
  const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ? LIMIT 1").bind(await sha256(token)).first();
  return !!row && Number(row.expires_at) > Math.floor(Date.now() / 1000);
}
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "Database binding DB is not configured." }, 503);
  try {
    if (!await isAdmin(request, env)) return json({ error: "Admin authentication required." }, 401);
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
    const type = (url.searchParams.get("type") || "").trim().slice(0, 30);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    const where = [];
    const binds = [];
    if (q) { where.push("(title LIKE ? OR episode_of LIKE ?)"); binds.push("%" + q.replace(/[\\%_]/g, "\\$&") + "%", "%" + q.replace(/[\\%_]/g, "\\$&") + "%"); }
    if (["Movie", "Drama", "Episode", "Reel"].includes(type)) { where.push("type = ?"); binds.push(type); }
    const sql = "SELECT id,type,title,description,poster,category,year,rating,video_url,subtitle_url,episode_of,episode_number,created_at FROM catalog" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY created_at DESC LIMIT ?";
    binds.push(limit);
    const result = await env.DB.prepare(sql).bind(...binds).all();
    return json({ items: result.results || [], count: (result.results || []).length, limit });
  } catch {
    return json({ error: "Could not load the admin catalog." }, 500);
  }
}
