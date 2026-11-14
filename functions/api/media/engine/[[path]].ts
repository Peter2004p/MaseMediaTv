interface Env {
  DB: D1Database;
  MEDIA_ENGINE_URL?: string;
  MEDIA_ENGINE_TOKEN?: string;
}
type Episode = { id?: string; streamUrl?: string; qualities?: { streamUrl?: string }[] };
type Title = { episodes?: Episode[] };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function b64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
async function issueToken(payload: { sid: string; eid: string; src: string; exp: number }, secret: string) {
  const encoded = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return encoded + "." + b64url(await hmac(encoded, secret));
}
async function readToken(token: string, secret: string) {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = b64url(await hmac(encoded, secret));
  if (signature.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < signature.length; i++) diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(fromB64url(encoded)));
    if (!value.sid || !value.eid || !value.src || !Number.isFinite(value.exp) || value.exp < Date.now()) return null;
    return value as { sid: string; eid: string; src: string; exp: number };
  } catch { return null; }
}
async function findAuthorizedSource(env: Env, episodeId: string, source: string) {
  const rows = await env.DB.prepare("SELECT metadata_json FROM titles").all<{ metadata_json: string }>();
  for (const row of rows.results || []) {
    try {
      const title = JSON.parse(row.metadata_json) as Title;
      const episodes = Array.isArray(title.episodes) ? title.episodes : [];
      const episode = episodes.find(e =>
        (episodeId && episodeId.length <= 200 && String(e.id) === episodeId) ||
        [e.streamUrl, ...(e.qualities || []).map(q => q.streamUrl)].some(url => typeof url === "string" && url === source)
      );
      if (!episode) continue;
      const allowed = [episode.streamUrl, ...(episode.qualities || []).map(q => q.streamUrl)];
      if (allowed.includes(source)) return true;
    } catch { /* Ignore malformed legacy metadata rows. */ }
  }
  return false;
}
function engineConfig(env: Env) {
  if (!env.MEDIA_ENGINE_URL || !env.MEDIA_ENGINE_TOKEN) throw new Error("MaseNet media engine is not configured");
  const base = env.MEDIA_ENGINE_URL.replace(/\/+$/, "");
  return { base, token: env.MEDIA_ENGINE_TOKEN };
}
async function validatePayload(env: Env, payload: { sid: string; eid: string; src: string; exp: number }) {
  if (!/^[a-f0-9-]{36}$/i.test(payload.sid)) return false;
  return findAuthorizedSource(env, payload.eid, payload.src);
}

export const onRequest = async ({ request, env, params }: { request: Request; env: Env; params: { path?: string } }) => {
  let config: ReturnType<typeof engineConfig>;
  try { config = engineConfig(env); } catch (error) { return json({ error: error instanceof Error ? error.message : "Media engine unavailable" }, 503); }
  const route = String(params.path || "").replace(/^\/+|\/+$/g, "");

  if (request.method === "POST" && route === "session") {
    let body: { episodeId?: string; source?: string };
    try { body = await request.json() as typeof body; } catch { return json({ error: "Invalid playback request" }, 400); }
    const episodeId = String(body.episodeId || "");
    const source = String(body.source || "");
    if (!episodeId || !source || source.length > 8192) return json({ error: "Episode and source are required" }, 400);
    if (!await findAuthorizedSource(env, episodeId, source)) return json({ error: "This source is not registered to that MaseNet episode" }, 403);
    let upstream: Response;
    try {
      upstream = await fetch(config.base + "/sessions", {
        method: "POST",
        headers: { authorization: "Bearer " + config.token, "content-type": "application/json" },
        body: JSON.stringify({ url: source })
      });
    } catch { return json({ error: "The MaseNet media engine could not be reached" }, 502); }
    const data = await upstream.json().catch(() => ({})) as { id?: string; streams?: unknown[]; subtitles?: { index: number; codec?: string; language?: string; title?: string }[]; error?: string };
    if (!upstream.ok || !data.id) return json({ error: data.error || "The media engine could not prepare this source" }, upstream.status || 502);
    const exp = Date.now() + 2 * 60 * 60 * 1000;
    const token = await issueToken({ sid: data.id, eid: episodeId, src: source, exp }, config.token);
    const basePath = "/api/media/engine/session/" + data.id;
    const subtitles = (data.subtitles || []).map(track => ({
      index: track.index,
      label: track.title || track.language || ("Subtitle " + track.index),
      language: track.language || "",
      codec: track.codec || "",
      url: "/api/media/engine/subtitle?stream=" + encodeURIComponent(String(track.index)) + "&token=" + encodeURIComponent(token)
    }));
    return json({
      sessionId: data.id,
      playlistUrl: basePath + "/index.m3u8?token=" + encodeURIComponent(token),
      streams: data.streams || [],
      subtitles,
      expiresAt: exp
    }, 201);
  }

  if (request.method === "GET" && route === "subtitle") {
    const token = new URL(request.url).searchParams.get("token") || "";
    const payload = await readToken(token, config.token);
    if (!payload || !await validatePayload(env, payload)) return json({ error: "Invalid or expired subtitle session" }, 403);
    const stream = new URL(request.url).searchParams.get("stream") || "";
    if (!/^\d{1,3}$/.test(stream)) return json({ error: "Invalid subtitle track" }, 400);
    const upstream = await fetch(config.base + "/subtitle?url=" + encodeURIComponent(payload.src) + "&stream=" + stream, {
      headers: { authorization: "Bearer " + config.token }
    });
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") || "text/vtt; charset=utf-8", "cache-control": "no-store" } });
  }

  const mediaMatch = route.match(/^session\/([a-f0-9-]{36})\/(index\.m3u8|segment_\d{5}\.ts)$/i);
  if ((request.method === "GET" || request.method === "HEAD") && mediaMatch) {
    const token = new URL(request.url).searchParams.get("token") || "";
    const payload = await readToken(token, config.token);
    if (!payload || payload.sid !== mediaMatch[1] || !await validatePayload(env, payload)) return json({ error: "Invalid or expired playback session" }, 403);
    const upstream = await fetch(config.base + "/sessions/" + payload.sid + "/" + mediaMatch[2], {
      method: request.method,
      headers: { authorization: "Bearer " + config.token }
    });
    if (!upstream.ok) return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" } });
    if (mediaMatch[2] === "index.m3u8") {
      const playlist = await upstream.text();
      const rewritten = playlist.split(/\r?\n/).map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        const filename = trimmed.split(/[?#]/)[0].split("/").pop() || "";
        if (!/^segment_\d{5}\.ts$/.test(filename)) return line;
        return "/api/media/engine/session/" + payload.sid + "/" + filename + "?token=" + encodeURIComponent(token);
      }).join("\n");
      return new Response(rewritten, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store", "access-control-allow-origin": "*" } });
    }
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "video/mp2t",
        "content-length": upstream.headers.get("content-length") || "",
        "cache-control": "no-store",
        "accept-ranges": "bytes",
        "access-control-allow-origin": "*"
      }
    });
  }
  return json({ error: "Unknown MaseNet media engine route" }, 404);
};
