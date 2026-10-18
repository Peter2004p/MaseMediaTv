import { json, ensureTables } from "./_helpers.js";

// Minimal, non-sensitive production smoke check for the account service.
export async function onRequestGet({ env }) {
  if (!env.DB) return json({ ok: false, service: "account", database: "unavailable" }, 503);
  try {
    await ensureTables(env.DB);
    await env.DB.prepare("SELECT 1 AS ok").first();
    return json({ ok: true, service: "account", database: "available" });
  } catch {
    return json({ ok: false, service: "account", database: "query_failed" }, 503);
  }
}
