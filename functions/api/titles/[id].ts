import { Env, json, requireAdmin } from "../auth/_shared";
const validateExternalEpisodeLinks = (episodes: unknown, requestUrl: string): string | null => {
  if (!Array.isArray(episodes)) return null;
  const ownOrigin = new URL(requestUrl).origin;
  for (const episode of episodes) {
    if (!episode || typeof episode !== "object" || Array.isArray(episode)) continue;
    const item = episode as Record<string, unknown>;
    const variants = Array.isArray(item.qualities) ? item.qualities as Record<string, unknown>[] : [];
    const sources = [item.streamUrl, item.downloadUrl, ...variants.flatMap(v => [v.streamUrl, v.downloadUrl])];
    for (const source of sources) {
      if (typeof source !== "string" || !source.trim()) continue;
      try {
        const url = new URL(source);
        if (url.protocol !== "https:") return "Movie and drama sources must use HTTPS.";
        if (url.origin === ownOrigin && url.pathname === "/api/media/file") return "MaseNet-hosted video files are disabled. Save an external HTTPS source URL instead.";
      } catch { return "Every movie and drama source must be a valid absolute HTTPS URL."; }
    }
  }
  return null;
};
const normalizeName = (value: unknown) => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const normalizeKind = (value: unknown) => {
  const type = String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  return ["drama", "dramas", "series", "tv series", "tv show", "show", "episode"].includes(type) ? "drama" : "movie";
};
export const onRequestPut: PagesFunction<Env> = async ({ request, env, params }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const requestedId = String(params.id || "");
  const body = await request.json() as Record<string, unknown>;
  const sourceError = body.action === "updateEpisode"
    ? validateExternalEpisodeLinks([body.episode], request.url)
    : validateExternalEpisodeLinks(body.episodes, request.url);
  if (sourceError) return json({ error: sourceError }, 400);
  const old = await env.DB.prepare("SELECT id FROM titles WHERE id=?").bind(requestedId).first<{id:string}>();
  if (body.action === "updateStatus") {
    const status = String(body.status || "").trim().toLowerCase();
    if (status !== "active" && status !== "ended") return json({ error: "Choose active or ended status." }, 400);
    const base = await env.DB.prepare("SELECT id,name,kind FROM titles WHERE id=?").bind(requestedId).first<{id:string;name:string;kind:string}>();
    if (!base) return json({ error: "Title not found. Refresh the library and try again." }, 404);
    const rows = await env.DB.prepare("SELECT id,name,metadata_json FROM titles WHERE kind=?").bind(base.kind).all<{id:string;name:string;metadata_json:string}>();
    const matching = (rows.results || []).filter(row => normalizeName(row.name) === normalizeName(base.name));
    if (!matching.length) return json({ error: "Title records could not be found." }, 404);
    await env.DB.batch(matching.map(row => {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>; } catch {}
      metadata.status = status;
      metadata.isEnded = status === "ended";
      return env.DB.prepare("UPDATE titles SET metadata_json=?,updated_at=datetime('now') WHERE id=?").bind(JSON.stringify(metadata), row.id);
    }));
    return json({ ok: true, id: base.id, name: base.name, status, updatedRecords: matching.length });
  }
  if (body.action === "updateEpisode") {
    let base = old
      ? await env.DB.prepare("SELECT id,name,kind FROM titles WHERE id=?").bind(old.id).first<{id:string;name:string;kind:string}>()
      : null;
    if (!base && typeof body.name === "string" && body.name.trim()) {
      const kind = normalizeKind(body.type);
      const rows = await env.DB.prepare("SELECT id,name,kind FROM titles WHERE kind=?").bind(kind).all<{id:string;name:string;kind:string}>();
      const matches = (rows.results || []).filter(row => normalizeName(row.name) === normalizeName(body.name));
      if (matches.length === 1) base = matches[0];
      else if (matches.length > 1) return json({ error: "More than one matching series exists. Refresh the Library and reopen the movie." }, 409);
    }
    if (!base) return json({ error: "Movie or series record not found. Refresh the Admin Library and reopen it." }, 404);
    const id = base.id;
    const candidates = await env.DB.prepare("SELECT id,name,kind,metadata_json FROM titles WHERE kind=?").bind(base.kind).all<{id:string;name:string;kind:string;metadata_json:string}>();
    const norm = (v: unknown) => String(v || "").normalize("NFKC").toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const episodeId = String(body.episodeId || "");
    const edited = body.episode && typeof body.episode === "object" ? body.episode as Record<string, unknown> : null;
    if (!episodeId || !edited) return json({ error: "An episode selection and updated episode are required." }, 400);
    const matchingRows = (candidates.results || []).filter(row => norm(row.name) === norm(base.name));
    let targetSeason = 1;
    let targetEpisode = 1;
    let targetRowId = "";
    for (const row of matchingRows) {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; } catch {}
      const episodes = Array.isArray(metadata.episodes) ? metadata.episodes as Record<string, unknown>[] : [];
      const selected = episodes.find((ep, i) => String(ep.id || row.id + "-episode-" + (i + 1)) === episodeId);
      if (!selected) continue;
      targetSeason = Number(selected.season) || 1;
      targetEpisode = Number(selected.episode) || 1;
      targetRowId = row.id;
      break;
    }
    if (!targetRowId) return json({ error: "Episode not found. Refresh the library and try again." }, 404);
    const statements = [];
    let savedEpisode: Record<string, unknown> | null = null;
    for (const row of matchingRows) {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; } catch {}
      const episodes = Array.isArray(metadata.episodes) ? metadata.episodes as Record<string, unknown>[] : [];
      let changed = false;
      const nextEpisodes: Record<string, unknown>[] = [];
      for (let episodeIndex = 0; episodeIndex < episodes.length; episodeIndex++) {
        const ep = episodes[episodeIndex];
        const sameEpisode = (Number(ep.season) || 1) === targetSeason && (Number(ep.episode) || 1) === targetEpisode;
        const isSelected = String(ep.id || row.id + "-episode-" + (episodeIndex + 1)) === episodeId;
        if (isSelected && row.id === targetRowId) {
          savedEpisode = { ...ep, ...edited, id: String(ep.id || episodeId) };
          nextEpisodes.push(savedEpisode);
          changed = true;
        } else {
          // Editing one quality must not remove the other quality variants
          // for the same season/episode stored in sibling records.
          nextEpisodes.push(ep);
        }
      }
      if (!changed) continue;
      if (nextEpisodes.length) {
        metadata.episodes = nextEpisodes;
        statements.push(env.DB.prepare("UPDATE titles SET metadata_json=?,updated_at=datetime('now') WHERE id=?").bind(JSON.stringify(metadata), row.id));
      } else {
        statements.push(env.DB.prepare("DELETE FROM titles WHERE id=?").bind(row.id));
      }
    }
    if (!savedEpisode) return json({ error: "Episode could not be updated. Refresh the library and try again." }, 409);
    if (statements.length) await env.DB.batch(statements);
    return json({ ok: true, episode: savedEpisode });
  }
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "A title name is required." }, 400);
  const kind = normalizeKind(body.type);
  // The Library can retain a stale card ID after records have been consolidated.
  // Resolve a missing ID by exact normalized title + type, but never guess when
  // more than one movie record has the same visible title.
  let targetId = old?.id || "";
  if (!targetId) {
    const rows = await env.DB.prepare("SELECT id,name FROM titles WHERE kind=?").bind(kind).all<{id:string;name:string}>();
    const matches = (rows.results || []).filter(row => normalizeName(row.name) === normalizeName(body.name));
    if (matches.length === 1) targetId = matches[0].id;
    else if (matches.length > 1) return json({ error: "More than one matching title exists. Refresh the Admin Library and select the exact record." }, 409);
  }
  if (!targetId) return json({ error: "Title not found. Refresh the Admin Library and reopen this movie." }, 404);
  const title: Record<string, unknown> = { ...body, id: targetId };
  title.type = kind === "drama" ? "Drama" : "Movie";
  await env.DB.prepare("UPDATE titles SET name=?,kind=?,metadata_json=?,updated_at=datetime('now') WHERE id=?")
    .bind(title.name, kind, JSON.stringify(title), targetId).run();
  return json({ title });
};
export const onRequestDelete: PagesFunction<Env> = async ({ request, env, params }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const id = String(params.id || "");
  const url = new URL(request.url);
  if (url.searchParams.get("action") === "deleteEpisode") {
    let base = await env.DB.prepare("SELECT id,name,kind FROM titles WHERE id=?").bind(id).first<{id:string;name:string;kind:string}>();
    const requestedName = url.searchParams.get("name") || "";
    const requestedType = url.searchParams.get("type") || "";
    if (!base && requestedName.trim()) {
      const kind = normalizeKind(requestedType);
      const rows = await env.DB.prepare("SELECT id,name,kind FROM titles WHERE kind=?").bind(kind).all<{id:string;name:string;kind:string}>();
      const matches = (rows.results || []).filter(row => normalizeName(row.name) === normalizeName(requestedName));
      if (matches.length === 1) base = matches[0];
      else if (matches.length > 1) return json({ error: "More than one matching series exists. Refresh the Library and reopen the movie." }, 409);
    }
    if (!base) return json({ error: "Movie or series record not found. Refresh the Admin Library and reopen it." }, 404);
    const candidates = await env.DB.prepare("SELECT id,name,kind,metadata_json FROM titles WHERE kind=?").bind(base.kind).all<{id:string;name:string;kind:string;metadata_json:string}>();
    const norm = (v: unknown) => String(v || "").normalize("NFKC").toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const episodeId = url.searchParams.get("episodeId") || "";
    let targetSeason = 1;
    let targetEpisode = 0;
    let targetFound = false;
    const matchingRows = (candidates.results || []).filter(row => norm(row.name) === norm(base.name));
    // Resolve the selected episode by its stable ID before changing any records.
    for (const row of matchingRows) {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; } catch {}
      const episodes = Array.isArray(metadata.episodes) ? metadata.episodes as Record<string, unknown>[] : [];
      const selected = episodes.find((ep, i) => String(ep.id || row.id + "-episode-" + (i + 1)) === episodeId);
      if (!selected) continue;
      targetSeason = Number(selected.season) || 1;
      targetEpisode = Number(selected.episode) || 1;
      targetFound = true;
      break;
    }
    if (!targetFound) return json({ error: "Episode not found. Refresh the library and try again." }, 404);
    let removedCount = 0;
    const statements = [];
    for (const row of matchingRows) {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; } catch {}
      const episodes = Array.isArray(metadata.episodes) ? metadata.episodes as Record<string, unknown>[] : [];
      const remaining = episodes.filter(ep => {
        const sameEpisode = (Number(ep.season) || 1) === targetSeason && (Number(ep.episode) || 1) === targetEpisode;
        if (sameEpisode) removedCount++;
        return !sameEpisode;
      });
      if (remaining.length === episodes.length) continue;
      if (remaining.length) {
        metadata.episodes = remaining;
        statements.push(env.DB.prepare("UPDATE titles SET metadata_json=?,updated_at=datetime('now') WHERE id=?").bind(JSON.stringify(metadata), row.id));
      } else {
        statements.push(env.DB.prepare("DELETE FROM titles WHERE id=?").bind(row.id));
      }
    }
    if (!removedCount) return json({ error: "Episode not found. Refresh the library and try again." }, 404);
    if (statements.length) await env.DB.batch(statements);
    return json({ ok: true, deletedSeason: targetSeason, deletedEpisode: targetEpisode, deletedEntries: removedCount });
  }
  const requestedName = url.searchParams.get("name") || "";
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
