import { json, requireAdmin, checkOrigin } from "../_lib/admin.js";

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
