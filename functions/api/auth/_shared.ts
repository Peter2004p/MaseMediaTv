export interface Env { DB: D1Database; ADMIN_EMAIL?: string; }
export type AdminRole = "owner" | "bulk";
export const ownerEmail = (env: Env) => (env.ADMIN_EMAIL || "pb5089780@gmail.com").trim().toLowerCase();
export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
export const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
};
export const cookie = (request: Request, name: string) => {
  for (const item of (request.headers.get("Cookie") || "").split(";")) {
    const i = item.indexOf("=");
    if (i > 0 && item.slice(0, i).trim() === name) {
      const value = item.slice(i + 1).trim();
      try { return decodeURIComponent(value); } catch { return null; }
    }
  }
  return null;
};
export async function ensureAdminRoles(env: Env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_roles (email TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','bulk')), created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  const owner = ownerEmail(env);
  await env.DB.prepare("INSERT INTO admin_roles (email,role) VALUES (?,'owner') ON CONFLICT(email) DO UPDATE SET role='owner'").bind(owner).run();
  return owner;
}
export async function currentAdmin(request: Request, env: Env) {
  const token = cookie(request, "masetv_session");
  if (!token) return null;
  await ensureAdminRoles(env);
  return await env.DB.prepare("SELECT a.id,a.email,r.role FROM admin_sessions s JOIN admins a ON a.id=s.admin_id JOIN admin_roles r ON lower(r.email)=lower(a.email) WHERE s.id_hash=? AND s.expires_at > datetime('now') AND lower(a.email)=lower(r.email)")
    .bind(await sha256(token)).first<{ id: string; email: string; role: AdminRole }>();
}
export async function requireAdmin(request: Request, env: Env) {
  const admin = await currentAdmin(request, env);
  if (!admin) return { admin: null, response: json({ error: "Admin sign-in required" }, 401) };
  if (admin.role === "owner") return { admin, response: null };
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const allowed = (path === "/api/titles" && method === "POST") ||
    (/^\/api\/titles\/[^/]+$/.test(path) && method === "PUT") ||
    (path === "/api/media/upload" && method === "POST");
  if (!allowed) return { admin: null, response: json({ error: "This account is limited to Bulk URLs and Auto Bulk URLs. Ask the MaseNet owner for access to other admin tools." }, 403) };
  return { admin, response: null };
}
export async function requireOwner(request: Request, env: Env) {
  const gate = await requireAdmin(request, env);
  if (gate.response) return gate;
  if (gate.admin?.role !== "owner") return { admin: null, response: json({ error: "Only the MaseNet owner can manage administrator accounts." }, 403) };
  return gate;
}
