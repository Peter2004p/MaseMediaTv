import { Env, json, requireAdmin } from "../auth/_shared";
const normalizeName = (value: unknown) => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const normalizeKind = (value: unknown) => {
  const type = String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  return ["drama", "dramas", "series", "tv series", "tv show", "show", "episode"].includes(type) ? "drama" : "movie";
};
export const onRequestPut: PagesFunction<Env> = async ({ request, env, params }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const id = String(params.id || "");
  const old = await env.DB.prepare("SELECT id FROM titles WHERE id=?").bind(id).first();
  if (!old) return json({ error: "Title not found." }, 404);
  const body = await request.json() as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "A title name is required." }, 400);
  const title: Record<string, unknown> = { ...body, id };
  const kind = normalizeKind(title.type);
  title.type = kind === "drama" ? "Drama" : "Movie";
  await env.DB.prepare("UPDATE titles SET name=?,kind=?,metadata_json=?,updated_at=datetime('now') WHERE id=?")
    .bind(title.name, kind, JSON.stringify(title), id).run();
  return json({ title });
};
export const onRequestDelete: PagesFunction<Env> = async ({ request, env, params }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const id = String(params.id || "");
  const requestedName = new URL(request.url).searchParams.get("name") || "";
  const requestedType = new URL(request.url).searchParams.get("type") || "";
  const selected = await env.DB.prepare("SELECT id,name,kind FROM titles WHERE id=?").bind(id).first<{id:string;name:string;kind:string}>();
  // The catalog combines same-name drama records into one visible series. Resolve the
  // canonical title from the ID, or use the UI's exact title fallback for stale IDs.
  const name = selected?.name || requestedName;
  const kind = selected?.kind || (requestedName ? normalizeKind(requestedType) : "");
  if (!name.trim() || !kind) return json({ error: "Title not found. Refresh the library and try again." }, 404);
  const rows = await env.DB.prepare("SELECT id,name FROM titles WHERE kind=?").bind(kind).all<{id:string;name:string}>();
  const matchingIds = (rows.results || []).filter(row => normalizeName(row.name) === normalizeName(name)).map(row => row.id);
  if (!matchingIds.length) return json({ error: "Title not found. No matching library records were found." }, 404);
  const statements = matchingIds.map(recordId => env.DB.prepare("DELETE FROM titles WHERE id=?").bind(recordId));
  await env.DB.batch(statements);
  return json({ ok: true, deletedRecords: matchingIds.length, title: name });
};
