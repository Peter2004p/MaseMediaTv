export async function onRequestGet({ env }) {
  return Response.json({ ok: true, service: "masenet-api", databaseConfigured: Boolean(env.DB), writeOperations: "disabled-pending-admin-auth" }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
