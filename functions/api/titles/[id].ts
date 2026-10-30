import { Env, json, requireAdmin } from "../auth/_shared";

type StoredTitle = { id: string; name: string; kind: string; metadata_json: string };
const normalize = (value: unknown) => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const isDrama = (value: unknown) => ["drama", "dramas", "series", "tv series", "tv show", "show", "episode"].includes(String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " "));

export const onRequestPut: PagesFunction<Env> = async ({ request, env, params }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const id = String(params.id || "");
  const old = await env.DB.prepare("SELECT id,name,kind,metadata_json FROM titles WHERE id=?").bind(id).first<StoredTitle>();
  if (!old) return json({ error: "Title not found. Refresh the library and try again." }, 404);
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return json({ error: "The edit could not be read. Please reopen the editor and try again." }, 400); }
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "A title name is required." }, 400);

  const title: Record<string, unknown> = { ...body, id, name: body.name.trim() };
  const kind = isDrama(title.type) ? "drama" : "movie";
  title.type = kind === "drama" ? "Drama" : "Movie";

  // The public catalogue groups same-name drama records into one series. When that
  // grouped series is edited, consolidate the underlying legacy records so the
  // removed/old data cannot reappear on the next catalogue refresh.
  const duplicateIds: string[] = [];
  if (kind === "drama" && old.kind.toLowerCase() === "drama") {
    const rows = await env.DB.prepare("SELECT id,name,kind,metadata_json FROM titles WHERE kind='drama' AND id<>?").bind(id).all<StoredTitle>();
    const oldKey = normalize(old.name);
    for (const row of rows.results || []) {
      let metadataName = row.name;
      try { const metadata = JSON.parse(row.metadata_json); if (typeof metadata?.name === "string") metadataName = metadata.name; } catch {}
      if (normalize(row.name) === oldKey || normalize(metadataName) === oldKey) duplicateIds.push(row.id);
    }
  }

  const statements = [
    env.DB.prepare("UPDATE titles SET name=?,kind=?,metadata_json=?,updated_at=datetime('now') WHERE id=?")
      .bind(title.name, kind, JSON.stringify(title), id),
    ...duplicateIds.map(duplicateId => env.DB.prepare("DELETE FROM titles WHERE id=?").bind(duplicateId)),
  ];
  await env.DB.batch(statements);
  return json({ title, consolidatedRecords: duplicateIds.length });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env, params }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const id = String(params.id || "");
  const old = await env.DB.prepare("SELECT id,name,kind,metadata_json FROM titles WHERE id=?").bind(id).first<StoredTitle>();
  if (!old) return json({ error: "This title was not found. Refresh the library and try again." }, 404);

  // A displayed drama can represent several legacy rows with the same normalized
  // title. Delete the whole logical series, not just the first row returned by GET.
  const ids = [id];
  if (old.kind.toLowerCase() === "drama") {
    const rows = await env.DB.prepare("SELECT id,name,metadata_json FROM titles WHERE kind='drama' AND id<>?").bind(id).all<StoredTitle>();
    const key = normalize(old.name);
    for (const row of rows.results || []) {
      let metadataName = row.name;
      try { const metadata = JSON.parse(row.metadata_json); if (typeof metadata?.name === "string") metadataName = metadata.name; } catch {}
      if (normalize(row.name) === key || normalize(metadataName) === key) ids.push(row.id);
    }
  }
  const results = await env.DB.batch(ids.map(titleId => env.DB.prepare("DELETE FROM titles WHERE id=?").bind(titleId)));
  const deleted = results.reduce((sum, result) => sum + Number(result.meta.changes || 0), 0);
  if (!deleted) return json({ error: "Nothing was deleted. Refresh the library and try again." }, 404);
  return json({ ok: true, deletedRecords: deleted });
};
