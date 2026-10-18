export async function onRequestGet({ env }) {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": "application/json; charset=utf-8"
  };
  if (!env.DB) {
    return Response.json({
      ok: false,
      service: "masenet-api",
      databaseConfigured: false,
      catalogReady: false,
      adminTablesReady: false
    }, { status: 503, headers });
  }

  try {
    // Read-only readiness check: never creates, alters, or resets tables.
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('catalog','admins','sessions')"
    ).all();
    const names = new Set((result.results || []).map(row => row.name));
    const catalogReady = names.has("catalog");
    const adminTablesReady = names.has("admins") && names.has("sessions");
    return Response.json({
      ok: catalogReady && adminTablesReady,
      service: "masenet-api",
      databaseConfigured: true,
      catalogReady,
      adminTablesReady,
      mode: "read-only-readiness-check"
    }, { status: catalogReady && adminTablesReady ? 200 : 503, headers });
  } catch {
    return Response.json({
      ok: false,
      service: "masenet-api",
      databaseConfigured: true,
      catalogReady: false,
      adminTablesReady: false,
      error: "Database readiness query failed."
    }, { status: 503, headers });
  }
}
