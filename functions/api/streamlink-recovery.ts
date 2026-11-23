import { json } from "./auth/_shared";

interface Env {
  DB: D1Database;
  STREAMLINK_RECOVERY_SECRET?: string;
  STREAMLINK_RECOVERY_SCAN_SECRET?: string;
  STREAMLINK_RECOVERY_ALLOWED_HOSTS?: string;
  KDL_AIR_REDISTRIBUTION_AUTHORIZED?: string;
  KDL_AIR_REDISTRIBUTION_AUTHORIZATION_REFERENCE?: string;
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

const normalizeCodec = (value: string) => ({ hevc: "x265", h265: "x265", h264: "x264" } as Record<string,string>)[value.toLowerCase()] || value.toLowerCase();

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
const qualityFromUrl = (value: unknown) => {
  const url = safeHttpsUrl(value);
  return url?.pathname.match(/(?:^|[._+\\-])(2160p|1440p|1080p|720p|576p|540p|480p|360p)(?=[._+\\-]|$)/i)?.[1] || "Unknown";
};
const codecFromUrl = (value: unknown) => {
  const url = safeHttpsUrl(value);
  return url?.pathname.match(/(?:^|[._+\\-])(x265|h265|hevc|x264|h264|av1)(?=[._+\\-]|$)/i)?.[1] || "Unknown";
};


const base64UrlBytes = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const decodeJwtPart = (value: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(base64UrlBytes(value))) as Record<string, unknown>;

const verifyGitHubActionsToken = async (token: string): Promise<Record<string, unknown> | null> => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = decodeJwtPart(parts[0]);
    const claims = decodeJwtPart(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const now = Math.floor(Date.now() / 1000);
    const audience = claims.aud;
    const hasAudience = Array.isArray(audience)
      ? audience.includes("masenet-streamlink-recovery")
      : audience === "masenet-streamlink-recovery";
    if (claims.iss !== "https://token.actions.githubusercontent.com" ||
        !hasAudience || Number(claims.exp) <= now || Number(claims.nbf || 0) > now + 30 ||
        String(claims.repository || "").toLowerCase() !== "peter2004p/masemediatv" ||
        claims.ref !== "refs/heads/main" ||
        claims.workflow !== "MaseNet Streamlink Recovery" ||
        typeof claims.workflow_ref !== "string") return null;
    const jwksResponse = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks");
    if (!jwksResponse.ok) return null;
    const jwks = await jwksResponse.json() as { keys?: (JsonWebKey & { kid?: string })[] };
    const jwk = (jwks.keys || []).find(key => key.kid === header.kid);
    if (!jwk) return null;
    const publicKey = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
    );
    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" }, publicKey, base64UrlBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
    return valid ? claims : null;
  } catch {
    return null;
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
      // Reject internally inconsistent catalogue variants. Some imported rows
      // label a 720p file as 1080p; the filename is the stronger evidence.
      const pathQuality = streamUrl.pathname.match(/(?:^|[._+\\-])(2160p|1440p|1080p|720p|576p|540p|480p|360p)(?=[._+\\-]|$)/i)?.[1];
      if (pathQuality && String(variant.quality || "").toLowerCase() !== pathQuality.toLowerCase()) return;
      const pathCodec = streamUrl.pathname.match(/(?:^|[._+\\-])(x265|h265|hevc|x264|h264|av1)(?=[._+\\-]|$)/i)?.[1];
      if (pathCodec && variant.codec && normalizeCodec(String(variant.codec)) !== normalizeCodec(pathCodec)) return;
      let filename = streamUrl.pathname.split("/").pop() || "";
      try { filename = decodeURIComponent(filename); } catch {}
      filename = filename.replace(/\\.(?:mkv|mp4|m4v|avi)$/i, "");
      const releaseTag = filename.match(/(?:x265|h265|hevc|x264|h264|av1)[+._-]+([a-z0-9]{2,12})$/i)?.[1] || "";
      entries.push({
        titleId: row.id, title: row.name, kind: row.kind, episodeId, episodeIndex,
        season, episode: episodeNumber, quality: String(variant.quality || pathQuality || "Unknown"),
        codec: String(variant.codec || pathCodec || "Unknown"), releaseTag,
        streamUrl: String(variant.streamUrl),
        variantIndex: root ? -1 : variantIndex, isPrimary: root
      });
    };
    add(episode, -1, true);
    variants.forEach((variant, index) => add(variant, index, false));
  });
  return [...titleEntries, ...entries];
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return json({ ok: false, error: "A JSON request body is required." }, 400); }

  const configured = String(env.STREAMLINK_RECOVERY_SECRET || "").trim();
  const scanOnlyConfigured = String(env.STREAMLINK_RECOVERY_SCAN_SECRET || "").trim();
  const supplied = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const recoveryAuthorized = !!configured && !!supplied && await constantTimeEqual(configured, supplied);
  const scanOnlyAuthorized = body.action === "scan" && !!scanOnlyConfigured && !!supplied &&
    await constantTimeEqual(scanOnlyConfigured, supplied);
  const oidcClaims = !recoveryAuthorized && !scanOnlyAuthorized && !!supplied
    ? await verifyGitHubActionsToken(supplied)
    : null;
  const workflowRef = String(oidcClaims?.workflow_ref || "").toLowerCase();
  const recoveryWorkflowRef = "peter2004p/masemediatv/.github/workflows/streamlink-recovery.yml@refs/heads/main";
  const dryRunWorkflowRef = "peter2004p/masemediatv/.github/workflows/masenet-preview-recovery-dry-run.yml@refs/heads/main";
  const oidcScanAuthorized = body.action === "scan" &&
    (workflowRef === recoveryWorkflowRef || workflowRef === dryRunWorkflowRef);
  const oidcReplaceAuthorized = body.action === "replace" && workflowRef === recoveryWorkflowRef;
  const oidcAuthorized = !!oidcClaims && (oidcScanAuthorized || oidcReplaceAuthorized);
  if (!recoveryAuthorized && !scanOnlyAuthorized && !oidcAuthorized) {
    return json({ ok: false, error: "Unauthorized recovery service." }, 401);
  }

  // Only the exact main-branch recovery workflow can present an OIDC token
  // for replacement. The separately named dry-run workflow is scan-only.
  // The recovery runner still fails closed until redistribution rights have
  // been explicitly reviewed and configured.

  if (body.action === "scan") {
    const rows = await env.DB.prepare("SELECT id,name,kind,metadata_json,stream_url,quality FROM titles WHERE kind IN ('movie','drama')")
      .all<TitleRow>();
    const links = (rows.results || []).flatMap(row => streamEntries(row, parseMetadata(row.metadata_json)));
    return json({ ok: true, scannedAt: new Date().toISOString(), count: links.length, links });
  }

  if (body.action === "replace") {
    // Enforce the redistribution-rights gate at the API boundary, not only
    // in the GitHub runner. A direct API caller cannot bypass the runner's
    // preflight check. The reference records the operator's documented basis;
    // this code does not itself determine whether rights exist.
    const authorizationReference = String(env.KDL_AIR_REDISTRIBUTION_AUTHORIZATION_REFERENCE || "").trim();
    if (env.KDL_AIR_REDISTRIBUTION_AUTHORIZED !== "true" || !authorizationReference) {
      return json({ ok: false, error: "Stream replacement is disabled until redistribution rights are verified and the server-side authorization reference is configured. No catalogue data was changed." }, 403);
    }

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

    // Enforce the destination allowlist at the database boundary as well as in
    // the runner. A compromised or misconfigured caller cannot write a stream
    // URL from an arbitrary HTTPS host. Exact hostname matches only.
    const allowedHosts = String(env.STREAMLINK_RECOVERY_ALLOWED_HOSTS || "")
      .split(",")
      .map(host => host.trim().toLowerCase())
      .filter(Boolean);
    if (!allowedHosts.length) {
      return json({ ok: false, error: "Stream recovery is disabled: no authorized replacement-host allowlist is configured." }, 503);
    }
    if (!allowedHosts.includes(newUrl.hostname.toLowerCase())) {
      return json({ ok: false, error: "The replacement host is not on the authorized stream-source allowlist. No catalogue data was changed." }, 403);
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
    const currentQuality = String(episode.quality || qualityFromUrl(episode.streamUrl)).trim().toLowerCase();
    const currentCodec = normalizeCodec(String(episode.codec || codecFromUrl(episode.streamUrl)));
    if (String(episode.streamUrl || "") === oldUrlRaw && currentQuality === quality &&
        currentCodec === normalizeCodec(codec)) {
      episode.streamUrl = newUrl.toString();
      if (String(episode.downloadUrl || "") === oldUrlRaw) episode.downloadUrl = newUrl.toString();
      if (!episode.quality || String(episode.quality).trim().toLowerCase() === "unknown") episode.quality = body.quality;
      if (!episode.codec || String(episode.codec).trim().toLowerCase() === "unknown") episode.codec = body.codec;
      changed = true;
    } else {
      const variants = Array.isArray(episode.qualities) ? episode.qualities as Episode[] : [];
      const variant = variants.find(item =>
        String(item.streamUrl || "") === oldUrlRaw &&
        String(item.quality || qualityFromUrl(item.streamUrl)).trim().toLowerCase() === quality &&
        normalizeCodec(String(item.codec || codecFromUrl(item.streamUrl))) === normalizeCodec(codec)
      );
      if (variant) {
        variant.streamUrl = newUrl.toString();
        if (String(variant.downloadUrl || "") === oldUrlRaw) variant.downloadUrl = newUrl.toString();
        if (!variant.quality || String(variant.quality).trim().toLowerCase() === "unknown") variant.quality = body.quality;
        if (!variant.codec || String(variant.codec).trim().toLowerCase() === "unknown") variant.codec = body.codec;
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

// Recovery API is isolated to the Preview D1 binding during validation.
