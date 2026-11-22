import { json } from "../auth/_shared";
import { sendTelegramTitleNotifications } from "../_telegram-notifications";

interface Env {
  DB: D1Database;
  MASE_STREAM_BOT_TOKEN?: string;
  MASE_STREAM_BOT_WEBHOOK_SECRET?: string;
  ADMIN_TELEGRAM_CHAT_ID?: string;
  TELEGRAM_BOT_TOKEN?: string;
}
type TelegramMessage = {
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string };
  text?: string;
  caption?: string;
};
type ParsedStream = {
  url: string; filename: string; title: string; year: string; kind: "movie" | "drama";
  season: number; episode: number; quality: string; codec: string; format: string; host: string;
};
// Source labels belong to the stream provider, never to the catalogue title.
const stripSourceLabels = (value: string) => value
  .replace(/(^|[\s._+\-@])(?:KDLand|KLandd|KDLAir|iQIYI|IQIYI|Youku|Youk|VIKI|Viki|VIK|IQ)(?=$|[\s._+\-])/gi, " ")
  .replace(/\s+/g, " ").trim();
const normalize = (value: unknown) => stripSourceLabels(String(value ?? "").normalize("NFKC"))
  .toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const telegram = async (env: Env, method: string, payload: Record<string, unknown>) => {
  const token = String(env.MASE_STREAM_BOT_TOKEN || "").trim();
  if (!token) throw new Error("Stream Manager bot token is not configured.");
  const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) throw new Error(result.description || "Telegram API request failed.");
  return result;
};
const parseStream = (raw: string): ParsedStream | null => {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:") return null;
  let filename = url.pathname.split("/").pop() || "";
  try { filename = decodeURIComponent(filename); } catch { return null; }
  filename = filename.replace(/\+/g, " ").trim();
  if (!/\.(?:mkv|mp4|m4v|webm)$/i.test(filename)) return null;

  const year = filename.match(/\b(19\d{2}|20\d{2})\b/)?.[1] || "";
  const quality = filename.match(/\b(2160p|1440p|1080p|720p|576p|540p|480p|360p)\b/i)?.[1]?.toLowerCase() || "Unknown";
  const codec = filename.match(/\b(x265|h265|hevc|x264|h264|av1)\b/i)?.[1]?.toLowerCase() || "Unknown";
  const format = filename.split(".").pop()?.toLowerCase() || "unknown";
  const se = filename.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  const cleanTitle = (value: string) => value
    .replace(/\.(?:mkv|mp4|m4v|webm)$/i, "")
    .replace(/\b(19\d{2}|20\d{2})\b/g, " ")
    .replace(/\b(2160p|1440p|1080p|720p|576p|540p|480p|360p|x265|h265|hevc|x264|h264|av1|10bit|8bit|hdr10?|hdr|web[- .]?dl|webrip|bluray|blu[- .]?ray|brrip|dvdrip|aac\d*|ddp?\d*|dts(?:-hd)?|proper|repack)\b/ig, " ")
    .replace(/^@[^\s-]+[-_]/, " ")
    .replace(/[\[\](){}]/g, " ")
    .replace(/[+_.-]+/g, " ");
  const finalTitle = (value: string) => stripSourceLabels(value).replace(/\s+/g, " ").trim();

  if (se) {
    const after = filename.slice((se.index || 0) + se[0].length).replace(/^[\s@._-]+|[\s._-]+$/g, "");
    const title = finalTitle(cleanTitle(after));
    if (!title) return null;
    return { url: raw, filename, title, year, kind: "drama", season: Number(se[1]), episode: Number(se[2]), quality, codec, format, host: url.hostname };
  }

  const title = finalTitle(cleanTitle(filename));
  if (!title) return null;
  return { url: raw, filename, title, year, kind: "movie", season: 0, episode: 0, quality, codec, format, host: url.hostname };
};
const extractUrl = (message: TelegramMessage) => {
  const text = String(message.text || message.caption || "");
  return text.match(/https:\/\/[^\s<>]+/i)?.[0]?.replace(/[),.]+$/, "") || "";
};
const inferCodec = (streamUrl: unknown): string => {
  if (typeof streamUrl !== "string" || !streamUrl) return "unknown";
  try {
    const filename = decodeURIComponent(new URL(streamUrl).pathname.split("/").pop() || "").replace(/\+/g, " ");
    return filename.match(/\b(x265|h265|hevc|x264|h264|av1)\b/i)?.[1]?.toLowerCase() || "unknown";
  } catch { return "unknown"; }
};
const findMatches = async (env: Env, parsed: ParsedStream) => {
  const kind = parsed.kind === "drama" ? "drama" : "movie";
  const rows = await env.DB.prepare("SELECT id,name,kind,metadata_json FROM titles WHERE kind=?")
    .bind(kind).all<{ id: string; name: string; kind: string; metadata_json: string }>();
  return (rows.results || []).filter(row => {
    if (normalize(row.name) !== normalize(parsed.title)) return false;
    if (!parsed.year) return true;
    try {
      const existingYear = String((JSON.parse(row.metadata_json || "{}") as Record<string, unknown>).year || "");
      return !existingYear || existingYear === parsed.year;
    } catch { return true; }
  });
};
const applyPending = async (env: Env, pendingId: string) => {
  // Season/episode 0/0 is reserved for a standalone movie in the existing pending table.
  const pending = await env.DB.prepare("UPDATE stream_manager_pending SET status='applying' WHERE id=? AND status='pending' RETURNING id,stream_url,title,year,season,episode,quality,codec,format,host")
    .bind(pendingId)
    .first<{ id: string; stream_url: string; title: string; year: string; season: number; episode: number; quality: string; codec: string; format: string; host: string }>();
  if (!pending) return { ok: false, message: "This item was already processed or has expired." };
  const isMovie = Number(pending.season) === 0 && Number(pending.episode) === 0;
  const kind = isMovie ? "movie" : "drama";
  const type = isMovie ? "Movie" : "Drama";
  try {
    const matches = await env.DB.prepare("SELECT id,name,kind,metadata_json FROM titles WHERE kind=?")
      .bind(kind).all<{ id: string; name: string; kind: string; metadata_json: string }>();
    const matching = (matches.results || []).filter(row => {
      if (normalize(row.name) !== normalize(pending.title)) return false;
      if (!pending.year) return true;
      try {
        const existingYear = String((JSON.parse(row.metadata_json || "{}") as Record<string, unknown>).year || "");
        return !existingYear || existingYear === pending.year;
      } catch { return true; }
    });
    let row = matching.length === 1 ? matching[0] : null;
    let metadata: Record<string, unknown> = {};
    if (row) {
      try { metadata = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>; } catch {}
    } else if (matching.length > 1) {
      await env.DB.prepare("UPDATE stream_manager_pending SET status='needs_review',processed_at=datetime('now') WHERE id=? AND status='applying'")
        .bind(pendingId).run();
      return { ok: false, message: "More than one matching " + kind + " title exists. Resolve the duplicate titles in the Admin Library first." };
    }

    const episodes = Array.isArray(metadata.episodes) ? metadata.episodes as Record<string, unknown>[] : [];
    const streamVariant = {
      quality: pending.quality, codec: pending.codec, streamUrl: pending.stream_url,
      mimeType: pending.format === "mkv" ? "video/x-matroska" : pending.format === "m4v" ? "video/x-m4v" : pending.format === "webm" ? "video/webm" : "video/mp4"
    };
    let action: string;
    let episodeIndex = -1;

    if (!row) {
      const id = crypto.randomUUID();
      const firstEpisode = {
        id: crypto.randomUUID(), season: isMovie ? 1 : pending.season, episode: isMovie ? 1 : pending.episode,
        title: isMovie ? "Full Movie" : "Episode " + pending.episode,
        ...streamVariant, qualities: []
      };
      metadata = {
        id, name: pending.title, type, year: pending.year,
        quality: pending.quality, episodes: [firstEpisode]
      };
      await env.DB.prepare("INSERT INTO titles (id,name,kind,metadata_json) VALUES (?,?,?,?)")
        .bind(id, pending.title, kind, JSON.stringify(metadata)).run();
      action = isMovie ? "Created a new movie and added its stream" : "Created a new drama and added its first episode";
    } else {
      if (isMovie) {
        // The MaseNet title/player model represents a movie as one playable entry
        // inside its episodes array (season 1, episode 1).
        episodeIndex = episodes.findIndex(ep => Number(ep.season || 1) === 1 && Number(ep.episode || 1) === 1);
      } else {
        episodeIndex = episodes.findIndex(ep => Number(ep.season || 1) === pending.season && Number(ep.episode || 0) === pending.episode);
      }

      if (episodeIndex < 0) {
        episodes.push({
          id: crypto.randomUUID(), season: isMovie ? 1 : pending.season,
          episode: isMovie ? 1 : pending.episode,
          title: isMovie ? "Full Movie" : "Episode " + pending.episode,
          ...streamVariant, qualities: []
        });
        metadata.episodes = episodes;
        await env.DB.prepare("UPDATE titles SET metadata_json=?,updated_at=datetime('now') WHERE id=?")
          .bind(JSON.stringify(metadata), row.id).run();
        action = isMovie ? "Added a stream to the existing movie record" : "Added a new episode to the existing drama";
      } else {
        const episode = { ...episodes[episodeIndex] };
        const variants = Array.isArray(episode.qualities) ? episode.qualities as Record<string, unknown>[] : [];
        const existingRootCodec = String(episode.codec || inferCodec(episode.streamUrl)).toLowerCase();
        const metadataKnown = pending.quality.toLowerCase() !== "unknown" && pending.codec.toLowerCase() !== "unknown";
        const rootMatches = metadataKnown
          && String(episode.quality || "").toLowerCase() === pending.quality.toLowerCase()
          && existingRootCodec !== "unknown" && existingRootCodec === pending.codec.toLowerCase();
        const variantIndex = metadataKnown ? variants.findIndex(v => {
          const variantCodec = String(v.codec || inferCodec(v.streamUrl)).toLowerCase();
          return String(v.quality || "").toLowerCase() === pending.quality.toLowerCase()
            && variantCodec !== "unknown" && variantCodec === pending.codec.toLowerCase();
        }) : -1;
        if (rootMatches) {
          episodes[episodeIndex] = { ...episode, ...streamVariant };
          action = "Replaced the existing " + (isMovie ? "movie" : "episode") + " stream for the same quality and codec";
        } else if (variantIndex >= 0) {
          variants[variantIndex] = { ...variants[variantIndex], ...streamVariant };
          episodes[episodeIndex] = { ...episode, qualities: variants };
          action = "Replaced the matching quality and codec version";
        } else {
          variants.push(streamVariant);
          episodes[episodeIndex] = { ...episode, qualities: variants };
          action = "Added another quality/codec version to the existing " + (isMovie ? "movie" : "episode");
        }
        metadata.episodes = episodes;
        await env.DB.prepare("UPDATE titles SET metadata_json=?,updated_at=datetime('now') WHERE id=?")
          .bind(JSON.stringify(metadata), row.id).run();
      }
    }

    await env.DB.prepare("UPDATE stream_manager_pending SET status='applied',processed_at=datetime('now') WHERE id=? AND status='applying'")
      .bind(pendingId).run();
    if (!row) {
      await sendTelegramTitleNotifications(env, {
        id: String(metadata.id || ""), name: pending.title, type,
        year: pending.year, description: String(metadata.description || ""),
        posterUrl: String(metadata.posterUrl || "")
      }, true, []).catch(error => console.error("Stream Manager new-title notification failed:", error));
    } else if (!isMovie && episodeIndex < 0) {
      await sendTelegramTitleNotifications(env, {
        id: row.id, name: pending.title, type,
        year: String(metadata.year || pending.year || ""),
        description: String(metadata.description || ""),
        posterUrl: String(metadata.posterUrl || "")
      }, false, [{ season: pending.season, episode: pending.episode, title: "Episode " + pending.episode }])
        .catch(error => console.error("Stream Manager episode notification failed:", error));
    }
    const detail = isMovie
      ? "Movie: " + pending.title + (pending.year ? " (" + pending.year + ")" : "")
      : "Drama: " + pending.title + (pending.year ? " (" + pending.year + ")" : "") +
        "\nS" + String(pending.season).padStart(2, "0") + "E" + String(pending.episode).padStart(2, "0");
    return { ok: true, message: action + ".\n" + detail + "\n" + pending.quality + " · " + pending.codec };
  } catch (error) {
    await env.DB.prepare("UPDATE stream_manager_pending SET status='pending' WHERE id=? AND status='applying'")
      .bind(pendingId).run().catch(() => undefined);
    throw error;
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const token = String(env.MASE_STREAM_BOT_TOKEN || "").trim();
  const secret = String(env.MASE_STREAM_BOT_WEBHOOK_SECRET || "").trim();
  const adminId = String(env.ADMIN_TELEGRAM_CHAT_ID || "").trim();
  if (!token || !secret || !adminId) return json({ ok: false, error: "Stream Manager bot secrets or admin ID are not configured." }, 503);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return json({ ok: false }, 401);
  const update = await request.json().catch(() => ({})) as {
    update_id?: number;
    message?: TelegramMessage;
    callback_query?: { id: string; data?: string; from?: { id?: number | string }; message?: { chat?: { id?: number | string } } };
  };
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS stream_manager_pending (
    id TEXT PRIMARY KEY, stream_url TEXT NOT NULL, filename TEXT NOT NULL, title TEXT NOT NULL,
    year TEXT NOT NULL DEFAULT '', season INTEGER NOT NULL, episode INTEGER NOT NULL,
    quality TEXT NOT NULL, codec TEXT NOT NULL, format TEXT NOT NULL, host TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', received_at TEXT NOT NULL DEFAULT(datetime('now')),
    processed_at TEXT
  )`).run();
  // Telegram retries webhook deliveries. Claim each update ID once so a retry
  // cannot create a second pending item or repeat a catalogue write.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS stream_manager_updates (
    update_id INTEGER PRIMARY KEY, received_at TEXT NOT NULL DEFAULT(datetime('now'))
  )`).run();
  if (Number.isSafeInteger(update.update_id)) {
    const claimed = await env.DB.prepare("INSERT OR IGNORE INTO stream_manager_updates (update_id) VALUES (?)")
      .bind(update.update_id).run();
    if (Number(claimed.meta?.changes || 0) === 0) return json({ ok: true, duplicate: true });
  }
  if (update.callback_query) {
    const cb = update.callback_query;
    if (String(cb.from?.id || "") !== adminId) {
      await telegram(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Not authorised.", show_alert: true }).catch(() => undefined);
      return json({ ok: true });
    }
    const match = String(cb.data || "").match(/^(apply|ignore):([0-9a-f-]{36})$/i);
    if (!match) return json({ ok: true });
    await telegram(env, "answerCallbackQuery", { callback_query_id: cb.id, text: match[1] === "apply" ? "Applying catalogue update…" : "Submission dismissed." }).catch(() => undefined);
    if (match[1] === "ignore") {
      await env.DB.prepare("UPDATE stream_manager_pending SET status='ignored',processed_at=datetime('now') WHERE id=? AND status='pending'").bind(match[2]).run();
      return json({ ok: true });
    }
    const result = await applyPending(env, match[2]);
    const chatId = cb.message?.chat?.id;
    if (chatId) await telegram(env, "sendMessage", { chat_id: chatId, text: result.message });
    return json({ ok: true, applied: result.ok });
  }
  const message = update.message;
  if (!message || String(message.chat?.type || "") !== "private" || String(message.from?.id || "") !== adminId || String(message.chat?.id || "") !== adminId) {
    return json({ ok: true, ignored: true });
  }
  const incoming = String(message.text || message.caption || "").trim();
  if (/^\/(start|help)(?:\s|$)/i.test(incoming)) {
    await telegram(env, "sendMessage", { chat_id: adminId, text: "MaseNet Stream Manager is ready. Forward a movie or drama Streamlink URL and I will automatically publish it. New titles and episodes are announced; matching quality/codec links are replaced, while different versions are added." });
    return json({ ok: true });
  }
  const rawUrl = extractUrl(message);
  const parsed = rawUrl ? parseStream(rawUrl) : null;
  if (!parsed) {
    await telegram(env, "sendMessage", { chat_id: adminId, text: "I couldn't identify a supported movie or drama Streamlink. Forward an HTTPS video URL with a recognisable title and MKV, MP4, M4V or WEBM extension. Drama filenames should include S01E01-style episode numbering." });
    return json({ ok: true, parsed: false });
  }
  const matches = await findMatches(env, parsed);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO stream_manager_pending
    (id,stream_url,filename,title,year,season,episode,quality,codec,format,host)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(id, parsed.url, parsed.filename, parsed.title, parsed.year, parsed.season, parsed.episode, parsed.quality, parsed.codec, parsed.format, parsed.host).run();
  const detail = parsed.kind === "movie"
    ? "🎞 Movie"
    : "📺 Drama · S" + String(parsed.season).padStart(2, "0") + "E" + String(parsed.episode).padStart(2, "0");
  const result = await applyPending(env, id);
  const text = result.ok
    ? "✅ AUTOMATICALLY PUBLISHED\n\n" + result.message
      + "\n\nQuality: " + parsed.quality + " · " + parsed.codec
      + "\nFormat: " + parsed.format.toUpperCase()
      + "\nHost: " + parsed.host
    : "⚠️ AUTOMATIC PUBLISHING NEEDS ATTENTION\n\n" + parsed.title
      + "\n" + detail + "\n" + result.message
      + "\n\nNo catalogue change was made. Please check this title in the Admin Library.";
  await telegram(env, "sendMessage", { chat_id: adminId, text, disable_web_page_preview: true });
  return json({ ok: true, parsed: true, automaticallyApplied: result.ok, pendingId: id });
};
