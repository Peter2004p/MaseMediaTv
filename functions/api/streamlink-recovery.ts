import { json } from "./auth/_shared";

interface Env {
  DB: D1Database;
  STREAMLINK_RECOVERY_SECRET?: string;
}

type Episode = Record<string, unknown>;
type TitleRow = { id: string; name: string; kind: string; metadata_json: string; stream_url: string | null; quality: string | null };

const constantTimeEqual = async (left: string, right: string) => {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
};

const safeHttpsUrl = (value: unknown) => {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") return null;
    const host = url.hostname.toLowerCase();
    const bareHost = host.replace(/^\[|\]$/g, "");
    // Stream links must use public DNS names. Reject every IP literal and
    // common private/special-use suffix instead of maintaining an incomplete
    // list of private address ranges in this API layer.
    if (!host || !host.includes(".") || bareHost.includes(":") ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bareHost) ||
      host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      host.endsWith(".lan") || host.endsWith(".home.arpa") ||
      host.endsWith(".test") || host.endsWith(".invalid") ||
      host.endsWith(".example")) return null;
    return url;
  } catch { return null; }
};

const base64UrlBytes = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const decodeJwtPart = (value: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(base64UrlBytes(value))) as Record<string, unknown>;

const verifyGitHubActionsToken = async (token: string) => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = decodeJwtPart(parts[0]);
    const claims = decodeJwtPart(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return false;
    const now = Math.floor(Date.now() / 1000);
    const audience = claims.aud;
    const hasAudience = Array.isArray(audience)
      ? audience.includes("masenet-streamlink-recovery")
      : audience === "masenet-streamlink-recovery";
    if (claims.iss !== "https://token.actions.githubusercontent.com" ||
        !hasAudience || Number(claims.exp) <= now || Number(claims.nbf || 0) > now + 30 ||
        String(claims.repository || "").toLowerCase() !== "peter2004p/masemediatv" ||
        claims.ref !== "refs/heads/main" ||
        claims.workflow !== "MaseNet Streamlink Recovery") return false;
    const jwksResponse = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks");
    if (!jwksResponse.ok) return false;
    const jwks = await jwksResponse.json() as { keys?: (JsonWebKey & { kid?: string })[] };
    const jwk = (jwks.keys || []).find(key => key.kid === header.kid);
    if (!jwk) return false;
    const publicKey = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
    );
    return await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" }, publicKey, base64UrlBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
  } catch {
    return false;
  }
};

const parseMetadata = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};

const streamEntries = (row: TitleRow, metadata: Record<string, unknown>) => {
  const titleEntries: Array<Record<string, unknown>> = [];
  if (row.kind === "movie" && safeHttpsUrl(row.stream_url)) {
    titleEntries.push({
      titleId: row.id, title: row.name, kind: row.kind, episodeId: "__title__",
      episodeIndex: -1, season: 0, episode: 0,
      quality: String(row.quality || "Unknown"), codec: "Unknown",
      streamUrl: String(row.stream_url), variantIndex: -1, isPrimary: true, scope: "title"
    });
  }
  const episodes = Array.isArray(metadata.episodes) ? metadata.episodes as Episode[] : [];
  const entries: Array<Record<string, unknown>> = [];
  episodes.forEach((episode, episodeIndex) => {
    if (!episode || typeof episode !== "object") return;
    const episodeId = String(episode.id || row.id + "-episode-" + (episodeIndex + 1));
    const season = Number(episode.season) || 1;
    const episodeNumber = Number(episode.episode) || 1;
    const variants = Array.isArray(episode.qualities) ? episode.qualities as Episode[] : [];
    const add = (variant: Episode, variantIndex: number, root: boolean) => {
      const streamUrl = safeHttpsUrl(variant.streamUrl);
      if (!streamUrl) return;
      entries.push({
        titleId: row.id, title: row.name, kind: row.kind, episodeId, episodeIndex,
        season, episode: episodeNumber, quality: String(variant.quality || "Unknown"),
        codec: String(variant.codec || "Unknown"), streamUrl: String(variant.streamUrl),
        variantIndex: root ? -1 : variantIndex, isPrimary: root
      });
    };
    add(episode, -1, true);
    variants.forEach((variant, index) => add(variant, index, false));
  });
  return [...titleEntries, ...entries];
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const configured = String(env.STREAMLINK_RECOVERY_SECRET || "").trim();
  const supplied = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const staticAuthorized = !!configured && !!supplied && await constantTimeEqual(configured, supplied);
  const oidcAuthorized = !staticAuthorized && !!supplied && await verifyGitHubActionsToken(supplied);
  if (!staticAuthorized && !oidcAuthorized) {
    return json({ ok: false, error: "Unauthorized recovery service." }, 401);
  }

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return json({ ok: false, error: "A JSON request body is required." }, 400); }

  if (body.action === "scan") {
    const rows = await env.DB.prepare("SELECT id,name,kind,metadata_json,stream_url,quality FROM titles WHERE kind IN ('movie','drama')")
      .all<TitleRow>();
    const links = (rows.results || []).flatMap(row => streamEntries(row, parseMetadata(row.metadata_json)));
    return json({ ok: true, scannedAt: new Date().toISOString(), count: links.length, links });
  }

  if (body.action === "replace") {
    const titleId = String(body.titleId || "");
    const episodeId = String(body.episodeId || "");
    const oldUrlRaw = String(body.oldUrl || "");
    const oldUrl = safeHttpsUrl(oldUrlRaw);
    const newUrl = safeHttpsUrl(body.newUrl);
    const quality = String(body.quality || "Unknown").trim().toLowerCase();
    const codec = String(body.codec || "Unknown").trim().toLowerCase();
    if (!titleId || !episodeId || !oldUrl || !newUrl || oldUrlRaw === newUrl.toString()) {
      return json({ ok: false, error: "A title, episode, current URL and different replacement HTTPS URL are required." }, 400);
    }

    const row = await env.DB.prepare("SELECT id,name,kind,metadata_json,stream_url,quality FROM titles WHERE id=?")
      .bind(titleId).first<TitleRow>();
    if (!row) return json({ ok: false, error: "The title no longer exists." }, 404);

    // Movie primary streams are stored on the title row, not in metadata. Keep
    // this scope separate so a movie replacement can never touch an episode.
    if (episodeId === "__title__") {
      const currentQuality = String(row.quality || "Unknown").trim().toLowerCase();
      if (row.kind !== "movie" || String(row.stream_url || "") !== oldUrlRaw ||
          currentQuality !== quality || codec !== "unknown") {
        return json({ ok: false, error: "The exact movie stream no longer matches the scan. No catalogue data was changed." }, 409);
      }
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE titles SET stream_url=?,updated_at=datetime('now') WHERE id=? AND stream_url=? AND lower(coalesce(quality,'Unknown'))=?")
          .bind(newUrl.toString(), row.id, oldUrlRaw, quality),
        env.DB.prepare("INSERT INTO streamlink_recovery_history (id,title_id,episode_id,season,episode,quality,codec,old_url,new_url,source) SELECT ?,?,'__title__',0,0,?,?,?,?,'telegram-user-session' WHERE changes() > 0")
          .bind(crypto.randomUUID(), row.id, String(body.quality || "Unknown"),
            String(body.codec || "Unknown"), oldUrlRaw, newUrl.toString())
      ]);
      if (!results[0]?.meta?.changes) {
        return json({ ok: false, error: "The movie link changed during recovery. Scan again; nothing was overwritten." }, 409);
      }
      return json({ ok: true, replaced: true, title: row.name, scope: "title",
        quality: String(body.quality || "Unknown"), codec: String(body.codec || "Unknown") });
    }

    const metadata = parseMetadata(row.metadata_json);
    const episodes = Array.isArray(metadata.episodes) ? metadata.episodes as Episode[] : [];
    const index = Number(body.episodeIndex);
    const episode = Number.isInteger(index) && index >= 0
      ? episodes[index]
      : episodes.find((item, i) => String(item?.id || row.id + "-episode-" + (i + 1)) === episodeId);
    if (!episode || String(episode.id || row.id + "-episode-" + (episodes.indexOf(episode) + 1)) !== episodeId) {
      return json({ ok: false, error: "The exact episode could not be matched; no link was changed." }, 409);
    }

    let changed = false;
    const currentQuality = String(episode.quality || "Unknown").trim().toLowerCase();
    const currentCodec = String(episode.codec || "Unknown").trim().toLowerCase();
    if (String(episode.streamUrl || "") === oldUrlRaw && currentQuality === quality && currentCodec === codec) {
      episode.streamUrl = newUrl.toString();
      changed = true;
    } else {
      const variants = Array.isArray(episode.qualities) ? episode.qualities as Episode[] : [];
      const variant = variants.find(item =>
        String(item.streamUrl || "") === oldUrlRaw &&
        String(item.quality || "Unknown").trim().toLowerCase() === quality &&
        String(item.codec || "Unknown").trim().toLowerCase() === codec
      );
      if (variant) {
        variant.streamUrl = newUrl.toString();
        changed = true;
      }
      episode.qualities = variants;
    }
    if (!changed) {
      return json({ ok: false, error: "The source link changed since the scan. No catalogue data was overwritten." }, 409);
    }

    metadata.episodes = episodes;
    // Compare-and-swap the entire metadata document so a concurrent catalogue edit
    // cannot be overwritten by this recovery job. Keep the audit insert in the
    // same D1 batch and only insert it when the guarded UPDATE changed one row.
    const updatedMetadata = JSON.stringify(metadata);
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE titles SET metadata_json=?,updated_at=datetime('now') WHERE id=? AND metadata_json=?")
        .bind(updatedMetadata, row.id, row.metadata_json),
      env.DB.prepare(`INSERT INTO streamlink_recovery_history
        (id,title_id,episode_id,season,episode,quality,codec,old_url,new_url,source)
        SELECT ?,?,?,?,?,?,?,?,?,'telegram-user-session' WHERE changes() > 0`)
        .bind(crypto.randomUUID(), row.id, episodeId, Number(episode.season) || 1,
          Number(episode.episode) || 1, String(body.quality || "Unknown"),
          String(body.codec || "Unknown"), oldUrlRaw, newUrl.toString())
    ]);
    if (!results[0]?.meta?.changes) {
      return json({ ok: false, error: "The catalogue changed during recovery. No link was overwritten; scan again." }, 409);
    }

    return json({ ok: true, replaced: true, title: row.name, episodeId,
      season: Number(episode.season) || 1, episode: Number(episode.episode) || 1,
      quality: String(body.quality || "Unknown"), codec: String(body.codec || "Unknown") });
  }

  return json({ ok: false, error: "Unknown action. Use scan or replace." }, 400);
};
