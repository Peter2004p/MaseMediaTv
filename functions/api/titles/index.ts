import { Env, json, requireAdmin } from "../auth/_shared";
type StoredTitle = { id: string; name: string; kind: string; metadata_json: string; created_at: string };
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rows = await env.DB.prepare("SELECT id,name,kind,metadata_json,created_at FROM titles ORDER BY created_at DESC").all<StoredTitle>();
  const titles = (rows.results || []).map((row) => {
    try { return JSON.parse(row.metadata_json); }
    catch { return { id: row.id, name: row.name, type: row.kind === "drama" ? "Drama" : "Movie", episodes: [] }; }
  });
  return json({ titles });
};
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const body = await request.json() as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "A title name is required." }, 400);
  const id = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
  const title: Record<string, unknown> = { ...body, id };
  const kind = title.type === "Drama" ? "drama" : "movie";
  await env.DB.prepare("INSERT INTO titles (id,name,kind,metadata_json) VALUES (?,?,?,?)").bind(id, title.name, kind, JSON.stringify(title)).run();
  return json({ title }, 201);
};
