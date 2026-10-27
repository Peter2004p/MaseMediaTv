import { json, requireAdmin, type Env } from "./auth/_shared";

type HealthEnv = Env & { DB: D1Database };

// Read-only diagnostics: never changes catalogue, accounts, sessions, or migrations.
export const onRequestGet = async ({ request, env }: { request: Request; env: HealthEnv }) => {
  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;

  const checkedAt = new Date().toISOString();
  let database: "healthy" | "unavailable" = "unavailable";
  let tables: Record<string, boolean> = {};
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    database = "healthy";
    const known = ["admins", "admin_sessions", "titles", "broadcasts", "analytics_events", "user_library_state", "site_users", "site_user_sessions"];
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN (" + known.map(() => "?").join(",") + ")"
    ).bind(...known).all<{ name: string }>();
    const present = new Set((rows.results || []).map(row => row.name));
    tables = Object.fromEntries(known.map(name => [name, present.has(name)]));
  } catch {
    // Do not expose SQL errors or environment details in diagnostics.
  }

  return json({
    ok: database === "healthy",
    checkedAt,
    services: {
      database,
      adminAuth: "protected",
      catalogueData: tables.titles ? "table-present" : "not-confirmed",
      broadcasts: tables.broadcasts ? "table-present" : "not-confirmed",
      analytics: tables.analytics_events ? "table-present" : "not-yet-created",
      librarySync: tables.user_library_state ? "table-present" : "created-on-first-sync"
    },
    tables
  });
};
