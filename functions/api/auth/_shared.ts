export interface Env { DB: D1Database; ADMIN_EMAIL?: string; }
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
      // Malformed percent-encoding in an unrelated or forged cookie must not crash
      // every protected API route. Treat an invalid session cookie as unauthenticated.
      try { return decodeURIComponent(value); } catch { return null; }
    }
  }
  return null;
};
export async function currentAdmin(request: Request, env: Env) {
  const token = cookie(request, "masetv_session");
  if (!token) return null;
  return await env.DB.prepare("SELECT a.id,a.email FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE s.id_hash=? AND s.expires_at > datetime('now')")
    .bind(await sha256(token)).first<{ id: string; email: string }>();
}
export async function requireAdmin(request: Request, env: Env) {
  const admin = await currentAdmin(request, env);
  if (!admin) return { admin: null, response: json({ error: "Admin sign-in required" }, 401) };
  if (admin.email.toLowerCase() !== (env.ADMIN_EMAIL || "pb5089780@gmail.com").toLowerCase())
    return { admin: null, response: json({ error: "Not authorized" }, 403) };
  return { admin, response: null };
}
