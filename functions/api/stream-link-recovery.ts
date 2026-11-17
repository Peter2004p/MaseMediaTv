import { json, requireAdmin, type Env } from "./auth/_shared";

type Episode = Record<string, unknown>;
const safeHttps = (value: unknown): URL | null => {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const parts = host.split(".");
    const ipv4 = parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
    const [a,b] = ipv4 ? parts.map(Number) : [0,0];
    const privateIp = ipv4 && (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:") || privateIp) return null;
    return url;
  } catch { return null; }
};

async function verifyExternalVideo(url: URL) {
  const check = async (method: "HEAD" | "GET") => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(url.toString(), {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: method === "GET"
          ? { Range: "bytes=0-0", "User-Agent": "MaseNet-Link-Recovery/1.0" }
          : { "User-Agent": "MaseNet-Link-Recovery/1.0" }
      });
      const status = response.status;
      const contentType = response.headers.get("content-type") || "";
      try { await response.body?.cancel(); } catch {}
      return { status, contentType };
    } finally { clearTimeout(timer); }
  };
  try {
    let result = await check("HEAD");
    if (result.status === 405 || result.status === 501 || result.status >= 500) result = await check("GET");
    const accepted = result.status === 200 || result.status === 206;
    return { ok: accepted, status: result.status, contentType: result.contentType,
      reason: accepted ? "The replacement URL responded successfully." :
        result.status >= 300 && result.status < 400 ? "Redirects are not accepted as verified replacement URLs." :
        "The replacement URL did not return HTTP 200 or 206." };
  } catch (error) {
    return { ok: false, status: 0, contentType: "", reason: error instanceof Error && error.name === "AbortError"
      ? "The replacement URL timed out." : "The replacement URL could not be reached." };
  }
}

/** Owner-only, verified episode URL replacement with optimistic locking and an audit trail. */
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;
  if (gate.admin?.role !== "owner") return json({ error: "Only the MaseNet owner can replace streaming sources." }, 403);

  let body: { titleId?: unknown; episodeId?: unknown; expectedOldUrl?: unknown; replacementUrl?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: "Send a valid JSON request." }, 400); }

  const titleId = String(body.titleId || "").slice(0, 160);
  const episodeId = String(body.episodeId || "").slice(0, 200);
  const expectedOldUrl = typeof body.expectedOldUrl === "string" ? body.expectedOldUrl : "";
  const replacement = safeHttps(body.replacementUrl);
  if (!titleId || !episodeId || !expectedOldUrl || !replacement)
    return json({ error: "A title, episode, current URL and valid external HTTPS replacement URL are required." }, 400);
  if (replacement.toString() === expectedOldUrl) return json({ error: "The replacement URL is identical to the current URL." }, 400);

  const verified = await verifyExternalVideo(replacement);
  if (!verified.ok) return json({ error: verified.reason, verification: verified }, 422);

  const row = await env.DB.prepare("SELECT id,name,metadata_json FROM titles WHERE id=?")
    .bind(titleId).first<{ id: string; name: string; metadata_json: string }>();
  if (!row) return json({ error: "Title not found." }, 404);

  let metadata: Record<string, unknown>;
  try { metadata = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>; }
  catch { return json({ error: "The saved title metadata could not be read. No changes were made." }, 409); }
  const episodes = Array.isArray(metadata.episodes) ? metadata.episodes as Episode[] : [];
  const index = episodes.findIndex((episode, i) => String(episode.id || row.id + "-episode-" + (i + 1)) === episodeId);
  if (index < 0) return json({ error: "Episode not found." }, 404);
  const current = episodes[index];
  if (String(current.streamUrl || "") !== expectedOldUrl)
    return json({ error: "The saved streaming URL changed since this repair started. Refresh before retrying.", conflict: true }, 409);

  const next = Object.assign({}, current, { streamUrl: replacement.toString() }) as Episode;
  if (String(current.downloadUrl || "") === expectedOldUrl) next.downloadUrl = replacement.toString();
  if (Array.isArray(current.qualities)) {
    next.qualities = (current.qualities as Episode[]).map(quality => ({
      ...quality,
      ...(quality.streamUrl === expectedOldUrl ? { streamUrl: replacement.toString() } : {}),
      ...(quality.downloadUrl === expectedOldUrl ? { downloadUrl: replacement.toString() } : {})
    }));
  }
  episodes[index] = next;
  metadata.episodes = episodes;

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS stream_link_recovery_log (
    id TEXT PRIMARY KEY, title_id TEXT NOT NULL, title_name TEXT NOT NULL,
    episode_id TEXT NOT NULL, old_url TEXT NOT NULL, new_url TEXT NOT NULL,
    verification_status INTEGER NOT NULL, admin_email TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();

  const update = await env.DB.prepare("UPDATE titles SET metadata_json=?,updated_at=datetime('now') WHERE id=? AND metadata_json=?")
    .bind(JSON.stringify(metadata), row.id, row.metadata_json).run();
  if (!update.meta?.changes) return json({ error: "The episode changed during repair. No URL was replaced; refresh and try again.", conflict: true }, 409);

  await env.DB.prepare("INSERT INTO stream_link_recovery_log (id,title_id,title_name,episode_id,old_url,new_url,verification_status,admin_email) VALUES (?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), row.id, row.name, episodeId, expectedOldUrl, replacement.toString(), verified.status, gate.admin.email).run();

  return json({ ok: true, title: row.name, episodeId, oldUrl: expectedOldUrl, newUrl: replacement.toString(),
    verification: verified, downloadUrlUpdated: String(current.downloadUrl || "") === expectedOldUrl,
    message: "The replacement was verified and saved. The original URL is recorded in the recovery log." });
};
