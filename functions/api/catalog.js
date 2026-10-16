// Public catalog API: intentionally excludes private streaming/download and subtitle source URLs.
// Admin-only media URLs must be served through a separately authenticated endpoint.
export async function onRequestGet({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: "Database binding DB is not configured." }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  }

  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("limit") || 24);
  const limit = Number.isInteger(raw) ? Math.min(100, Math.max(1, raw)) : 24;
  const search = (url.searchParams.get("q") || "").trim().slice(0, 100);

  // Keep this allowlist public-safe. Do not replace it with SELECT *.
  const columns = "id, type, title, description, poster, category, year, rating, episode_of, episode_number, created_at";
  try {
    let sql = "SELECT " + columns + " FROM catalog";
    const params = [];
    if (search) {
      sql += " WHERE title LIKE ? ESCAPE '\\\\' OR description LIKE ? ESCAPE '\\\\'";
      const term = "%" + search.replace(/[\\\\%_]/g, "\\\\$&") + "%";
      params.push(term, term);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const result = await env.DB.prepare(sql).bind(...params).all();
    const items = result.results || [];
    return Response.json({ items, count: items.length, limit }, {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Type": "application/json; charset=utf-8"
      }
    });
  } catch {
    return Response.json({ error: "Catalog query failed. Verify the catalog table schema." }, {
      status: 500,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  }
}

export async function onRequest({ request }) {
  return Response.json({ error: "Write operations are disabled until admin authentication is configured." }, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}
