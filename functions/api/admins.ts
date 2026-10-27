import { Env, json, requireOwner } from "./auth/_shared";
const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireOwner(request, env); if (gate.response) return gate.response;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_roles (email TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','bulk')), created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  const rows = await env.DB.prepare("SELECT email,role,created_at FROM admin_roles ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,email").all<{email:string;role:string;created_at:string}>();
  return json({ admins: (rows.results || []).map(row => ({ email: row.email, role: row.role, createdAt: row.created_at })) });
};
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireOwner(request, env); if (gate.response) return gate.response;
  const body = await request.json().catch(() => null) as {email?:unknown}|null;
  const email = normalizeEmail(body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: "Enter a valid Google account email address." }, 400);
  if (email === (env.ADMIN_EMAIL || "pb5089780@gmail.com").trim().toLowerCase()) return json({ error: "Your owner account already has full access." }, 400);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_roles (email TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','bulk')), created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await env.DB.prepare("INSERT INTO admin_roles (email,role) VALUES (?,'bulk') ON CONFLICT(email) DO UPDATE SET role=CASE WHEN admin_roles.role='owner' THEN 'owner' ELSE 'bulk' END").bind(email).run();
  return json({ ok: true, email, role: "bulk", message: "Restricted admin added. They must sign in with this verified Google account." }, 201);
};
export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireOwner(request, env); if (gate.response) return gate.response;
  const url = new URL(request.url), email = normalizeEmail(url.searchParams.get("email"));
  if (!email) return json({ error: "Admin email is required." }, 400);
  if (email === (env.ADMIN_EMAIL || "pb5089780@gmail.com").trim().toLowerCase()) return json({ error: "The owner account cannot be removed here." }, 400);
  const result = await env.DB.prepare("DELETE FROM admin_roles WHERE lower(email)=? AND role='bulk'").bind(email).run();
  if (!result.meta.changes) return json({ error: "Restricted admin not found." }, 404);
  return json({ ok: true, email });
};
