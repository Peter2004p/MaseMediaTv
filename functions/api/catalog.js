export async function onRequestGet({ request, env }) {
  if (!env.DB) return Response.json({ error: "Database binding DB is not configured." }, { status: 503 });
  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("limit") || 24);
  const limit = Number.isInteger(raw) ? Math.min(100, Math.max(1, raw)) : 24;
  const search = (url.searchParams.get("q") || "").trim().slice(0, 100);
  try {
    let sql = "SELECT * FROM catalog";
    const params = [];
    if (search) { sql += " WHERE title LIKE ? OR description LIKE ?"; const term = "%" + search.replace(/[\\%_]/g, "\\$&") + "%"; params.push(term, term); }
    sql += " ORDER BY id DESC LIMIT ?"; params.push(limit);
    const result = await env.DB.prepare(sql).bind(...params).all();
    return Response.json({ items: result.results || [], count: (result.results || []).length, limit }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return Response.json({ error: "Catalog query failed. Verify the catalog table schema." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
export async function onRequest({ request }) {
  return Response.json({ error: "Write operations are disabled until admin authentication is configured." }, { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } });
}
