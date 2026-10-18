import { Env, json, requireAdmin } from "../auth/_shared";
export const onRequestPut: PagesFunction<Env> = async ({ request, env, params }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const id = String(params.id || "");
  const old = await env.DB.prepare("SELECT id FROM titles WHERE id=?").bind(id).first();
  if (!old) return json({ error: "Title not found." }, 404);
  const body = await request.json() as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "A title name is required." }, 400);
  const title = { ...body, id };
  const kind = title.type === "Drama" ? "drama" : "movie";
  await env.DB.prepare("UPDATE titles SET name=?,kind=?,metadata_json=?,updated_at=datetime('now') WHERE id=?")
    .bind(title.name, kind, JSON.stringify(title), id).run();
  return json({ title });
};
export const onRequestDelete: PagesFunction<Env> = async ({ request, env, params }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const id = String(params.id || "");
  const result = await env.DB.prepare("DELETE FROM titles WHERE id=?").bind(id).run();
  if (!result.meta.changes) return json({ error: "Title not found." }, 404);
  return json({ ok: true });
};
