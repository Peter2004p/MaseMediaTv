import { json, requireAdmin, checkOrigin } from "./_lib/admin.js";

function parseRow(row) {
  try {
    const payload = JSON.parse(row.payload_json || "{}");
    return { ...payload, id: row.id, name: row.name, type: row.type, year: row.year, quality: row.quality, posterUrl: row.poster_url, description: row.description, featured: !!row.featured };
  } catch {
    return null;
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "Database binding DB is not configured." }, 503);
  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("limit") || 100);
  const limit = Number.isInteger(raw) ? Math.min(100, Math.max(1, raw)) : 100;
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  try {
    let stmt = "SELECT id,name,type,year,quality,poster_url,description,featured,payload_json FROM masetv_titles";
    const params = [];
    if (q) {
      stmt += " WHERE instr(lower(name), lower(?)) > 0 OR instr(lower(description), lower(?)) > 0";
      params.push(q, q);
    }
    stmt += " ORDER BY featured DESC, created_at DESC LIMIT ?";
    params.push(limit);
    const result = await env.DB.prepare(stmt).bind(...params).all();
    const titles = (result.results || []).map(parseRow).filter(Boolean);
    return json({ titles, count: titles.length });
  } catch {
    return json({ error: "Formal catalog is not initialized. Apply the reviewed migration on a test database first." }, 503);
  }
}

export async function onRequestPost({ request, env }) {
  if (!checkOrigin(request)) return json({ error: "Request origin rejected." }, 403);
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  if (!body || typeof body.name !== "string" || !body.name.trim() || !["Movie", "Drama"].includes(body.type) || !Array.isArray(body.episodes) || body.episodes.length < 1) {
    return json({ error: "A title name, Movie/Drama type, and at least one episode are required." }, 400);
  }
  if (body.name.length > 180 || JSON.stringify(body).length > 1_000_000) return json({ error: "Title data is too large." }, 413);
  const id = crypto.randomUUID();
  const name = body.name.trim();
  const type = body.type;
  const year = String(body.year || "").slice(0, 12);
  const quality = String(body.quality || "720p").slice(0, 12);
  const poster = String(body.posterUrl || "").slice(0, 2000);
  const description = String(body.description || "").slice(0, 8000);
  try {
    await env.DB.prepare("INSERT INTO masetv_titles (id,name,type,year,quality,poster_url,description,featured,payload_json) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, name, type, year, quality, poster, description, body.featured ? 1 : 0, JSON.stringify({ ...body, id, name, type, year, quality, posterUrl: poster, description })).run();
    return json({ title: { ...body, id, name, type, year, quality, posterUrl: poster, description } }, 201);
  } catch {
    return json({ error: "Could not save title. Verify the reviewed MaseTv migration exists in this environment." }, 503);
  }
}

export async function onRequestPut({ request, env, params }) {
  if (!checkOrigin(request)) return json({ error: "Request origin rejected." }, 403);
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  if (!body || typeof body.name !== "string" || !body.name.trim() || !["Movie", "Drama"].includes(body.type) || !Array.isArray(body.episodes)) return json({ error: "Invalid title data." }, 400);
  if (JSON.stringify(body).length > 1_000_000) return json({ error: "Title data is too large." }, 413);
  const id = String(params.id || "");
  try {
    const exists = await env.DB.prepare("SELECT id FROM masetv_titles WHERE id = ?").bind(id).first();
    if (!exists) return json({ error: "Title not found." }, 404);
    const year = String(body.year || "").slice(0, 12), quality = String(body.quality || "720p").slice(0, 12);
    const poster = String(body.posterUrl || "").slice(0, 2000), description = String(body.description || "").slice(0, 8000);
    const payload = { ...body, id, name: body.name.trim(), type: body.type, year, quality, posterUrl: poster, description };
    await env.DB.prepare("UPDATE masetv_titles SET name=?,type=?,year=?,quality=?,poster_url=?,description=?,featured=?,payload_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(payload.name, payload.type, year, quality, poster, description, body.featured ? 1 : 0, JSON.stringify(payload), id).run();
    return json({ ok: true, title: payload });
  } catch { return json({ error: "Could not update title." }, 503); }
}

export async function onRequestDelete({ request, env, params }) {
  if (!checkOrigin(request)) return json({ error: "Request origin rejected." }, 403);
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  try {
    const result = await env.DB.prepare("DELETE FROM masetv_titles WHERE id = ?").bind(String(params.id || "")).run();
    if (!result.meta?.changes) return json({ error: "Title not found." }, 404);
    return json({ deleted: true });
  } catch { return json({ error: "Could not delete title." }, 503); }
}
