const COOKIE = "masenet_admin";
const MAX_ROWS = 100;
const TYPES = new Set(["Movie", "Drama", "Episode", "Reel"]);
const PURPOSES = new Set(["Streaming", "Download"]);

function json(body, status = 200) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Type": "application/json; charset=utf-8"
  }});
}
function getCookie(request) {
  const raw = request.headers.get("Cookie") || "";
  const match = raw.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]*)"));
  return match ? match[1] : "";
}
async function sha256(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function authenticated(request, env) {
  const token = getCookie(request);
  if (!/^[a-f0-9]{64}$/i.test(token) || !env.DB) return false;
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ? LIMIT 1").bind(hash).first();
  return !!row && Number(row.expires_at) > Math.floor(Date.now() / 1000);
}
function isHttpsUrl(value, optional = false) {
  if (optional && (value == null || value === "")) return true;
  if (typeof value !== "string" || value.length > 2048) return false;
  try { const u = new URL(value); return u.protocol === "https:" && !!u.hostname; } catch { return false; }
}
function cleanText(value, max = 5000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function validateRow(row, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return { error: "Row must be an object." };
  const type = cleanText(row.type, 30);
  const title = cleanText(row.title, 200);
  const videoUrl = cleanText(row.video_url, 2048);
  const subtitleUrl = cleanText(row.subtitle_url, 2048);
  if (!TYPES.has(type)) return { error: "Unsupported content type." };
  if (!title) return { error: "Title is required." };
  if (!isHttpsUrl(videoUrl)) return { error: "A valid HTTPS media URL is required." };
  if (!isHttpsUrl(subtitleUrl, true)) return { error: "Subtitle URL must be HTTPS." };
  if (!isHttpsUrl(row.poster == null ? "" : String(row.poster).trim(), true)) return { error: "Poster URL must be HTTPS." };
  const yearText = row.year == null || row.year === "" ? "" : String(row.year).trim();
  const year = yearText ? Number(yearText) : null;
  if (year !== null && (!Number.isInteger(year) || year < 1888 || year > new Date().getUTCFullYear() + 5)) return { error: "Release year is invalid." };
  const episodeText = row.episode_number == null || row.episode_number === "" ? "" : String(row.episode_number).trim();
  const episode = episodeText ? Number(episodeText) : null;
  if (episode !== null && (!Number.isInteger(episode) || episode < 1 || episode > 10000)) return { error: "Episode number is invalid." };
  return { value: {
    id: crypto.randomUUID(),
    type,
    title,
    description: cleanText(row.description, 5000),
    poster: cleanText(row.poster, 2048),
    category: cleanText(row.category, 100),
    year,
    rating: cleanText(row.rating, 20),
    video_url: videoUrl,
    subtitle_url: subtitleUrl || null,
    episode_of: cleanText(row.episode_of, 200) || null,
    episode_number: episode
  }};
}
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "Database binding DB is not configured." }, 503);
  if (request.headers.get("Origin") && request.headers.get("Origin") !== new URL(request.url).origin) return json({ error: "Request origin rejected." }, 403);
  let ok = false;
  try { ok = await authenticated(request, env); } catch { return json({ error: "Authentication check failed." }, 503); }
  if (!ok) return json({ error: "Admin authentication required." }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Request must contain valid JSON." }, 400); }
  if (!body || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_ROWS) {
    return json({ error: "Provide between 1 and 100 media rows per import." }, 400);
  }
  const results = [];
  let inserted = 0;
  for (let i = 0; i < body.items.length; i++) {
    const checked = validateRow(body.items[i], i);
    if (checked.error) { results.push({ row: i + 1, status: "rejected", error: checked.error }); continue; }
    const item = checked.value;
    try {
      const duplicate = await env.DB.prepare("SELECT id FROM catalog WHERE video_url = ? LIMIT 1").bind(item.video_url).first();
      if (duplicate) { results.push({ row: i + 1, status: "skipped", reason: "This media URL already exists." }); continue; }
      await env.DB.prepare("INSERT INTO catalog (id,type,title,description,poster,category,year,rating,video_url,subtitle_url,episode_of,episode_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(item.id,item.type,item.title,item.description,item.poster,item.category,item.year,item.rating,item.video_url,item.subtitle_url,item.episode_of,item.episode_number).run();
      inserted++;
      results.push({ row: i + 1, status: "created", id: item.id, title: item.title });
    } catch {
      results.push({ row: i + 1, status: "failed", error: "Database insert failed for this row." });
    }
  }
  return json({ ok: inserted > 0, inserted, total: body.items.length, results }, inserted > 0 ? 200 : 422);
}
export async function onRequest({ request }) {
  return json({ error: "Use POST to import media." }, 405);
}
