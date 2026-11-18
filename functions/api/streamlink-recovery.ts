import { json } from "./auth/_shared";

interface Env {
  DB: D1Database;
  STREAMLINK_RECOVERY_SECRET?: string;
}

type Episode = Record<string, unknown>;
type TitleRow = { id: string; name: string; kind: string; metadata_json: string };

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
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "127.0.0.1" || host === "::1" || host.startsWith("10.") || host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
    return url;
  } catch { return null; }
};

const parseMetadata = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};

const streamEntries = (row: TitleRow, metadata: Record<string, unknown>) => {
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
        codec: String(variant.codec || "Unknown"), streamUrl: streamUrl.toString(),
        variantIndex: root ? -1 : variantIndex, isPrimary: root
      });
    };
    add(episode, -1, true);
    variants.forEach((variant, index) => add(variant, index, false));
  });
  return entries;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const configured = String(env.STREAMLINK_RECOVERY_SECRET || "").trim();
  const supplied = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!configured || !supplied || !(await constantTimeEqual(configured, supplied))) {
    return json({ ok: false, error: "Unauthorized recovery service." }, 401);
  }

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return json({ ok: false, error: "A JSON request body is required." }, 400); }

  if (body.action === "scan") {
    const rows = await env.DB.prepare("SELECT id,name,kind,metadata_json FROM titles WHERE kind IN ('movie','drama')")
      .all<TitleRow>();
    const links = (rows.results || []).flatMap(row => streamEntries(row, parseMetadata(row.metadata_json)));
    return json({ ok: true, scannedAt: new Date().toISOString(), count: links.length, links });
  }

  if (body.action === "replace") {
    const titleId = String(body.titleId || "");
    const episodeId = String(body.episodeId || "");
    const oldUrl = safeHttpsUrl(body.oldUrl);
    const newUrl = safeHttpsUrl(body.newUrl);
    const quality = String(body.quality || "Unknown").trim().toLowerCase();
    const codec = String(body.codec || "Unknown").trim().toLowerCase();
    if (!titleId || !episodeId || !oldUrl || !newUrl || oldUrl.toString() === newUrl.toString()) {
      return json({ ok: false, error: "A title, episode, current URL and different replacement HTTPS URL are required." }, 400);
    }

    const row = await env.DB.prepare("SELECT id,name,kind,metadata_json FROM titles WHERE id=?")
      .bind(titleId).first<TitleRow>();
    if (!row) return json({ ok: false, error: "The title no longer exists." }, 404);

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
    if (String(episode.streamUrl || "") === oldUrl.toString() && currentQuality === quality && currentCodec === codec) {
      episode.streamUrl = newUrl.toString();
      changed = true;
    } else {
      const variants = Array.isArray(episode.qualities) ? episode.qualities as Episode[] : [];
      const variant = variants.find(item =>
        String(item.streamUrl || "") === oldUrl.toString() &&
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
    await env.DB.prepare("UPDATE titles SET metadata_json=?,updated_at=datetime('now') WHERE id=?")
      .bind(JSON.stringify(metadata), row.id).run();

    await env.DB.prepare(`INSERT INTO streamlink_recovery_history
      (id,title_id,episode_id,season,episode,quality,codec,old_url,new_url,source)
      VALUES (?,?,?,?,?,?,?,?,?,'telegram-user-session')`)
      .bind(crypto.randomUUID(), row.id, episodeId, Number(episode.season) || 1,
        Number(episode.episode) || 1, String(body.quality || "Unknown"),
        String(body.codec || "Unknown"), oldUrl.toString(), newUrl.toString()).run();

    return json({ ok: true, replaced: true, title: row.name, episodeId,
      season: Number(episode.season) || 1, episode: Number(episode.episode) || 1,
      quality: String(body.quality || "Unknown"), codec: String(body.codec || "Unknown") });
  }

  return json({ ok: false, error: "Unknown action. Use scan or replace." }, 400);
};
