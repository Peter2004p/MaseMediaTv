import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { lookup } from "node:dns/promises";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 8080);
const ROOT = path.join(os.tmpdir(), "masenet-media-jobs");
const sessions = new Map();
const MIME = new Map([
  [".m3u8", "application/vnd.apple.mpegurl"],
  [".ts", "video/mp2t"],
  [".vtt", "text/vtt; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".json", "application/json; charset=utf-8"]
]);

function isPrivateAddress(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168);
  }
  const v = ip.toLowerCase();
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") ||
    /^fe[89ab]/.test(v) || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") ||
    v.startsWith("::ffff:192.168.") || v.startsWith("::ffff:169.254.");
}

async function validateSource(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid source URL"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Only public HTTPS media URLs are accepted");
  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Private or local media hosts are blocked");
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("Private media addresses are blocked");
  } else {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(x => isPrivateAddress(x.address))) throw new Error("Media host resolves to a private address");
  }
  return url.toString();
}

async function probe(source) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_format", "-show_streams", "-of", "json", source
  ], { timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  return {
    format: data.format || {},
    streams: (data.streams || []).map(s => ({
      index: s.index, codecType: s.codec_type, codec: s.codec_name,
      profile: s.profile || null, width: s.width || null, height: s.height || null,
      channels: s.channels || null, sampleRate: s.sample_rate || null,
      language: s.tags?.language || null, title: s.tags?.title || null,
      disposition: s.disposition || {}
    }))
  };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error("Request body too large");
  }
  return JSON.parse(raw || "{}");
}

async function waitForPlaylist(file, child, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { const info = await stat(file); if (info.size > 0) return true; } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function sendFile(res, file) {
  try {
    const info = await stat(file);
    res.writeHead(200, {
      "content-type": MIME.get(path.extname(file)) || "application/octet-stream",
      "content-length": String(info.size),
      "cache-control": "no-store",
      "accept-ranges": "bytes"
    });
    const { createReadStream } = await import("node:fs");
    createReadStream(file).pipe(res);
  } catch {
    json(res, 425, { error: "Media segment is not ready yet. Retry shortly." });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://container.local");
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, engine: "MaseNet FFmpeg Media Engine", ffmpeg: true });
    }
    if (req.method === "GET" && url.pathname === "/probe") {
      const source = await validateSource(url.searchParams.get("url") || "");
      return json(res, 200, await probe(source));
    }
    if (req.method === "GET" && url.pathname === "/subtitle") {
      const source = await validateSource(url.searchParams.get("url") || "");
      const streamIndex = Number(url.searchParams.get("stream"));
      if (!Number.isInteger(streamIndex) || streamIndex < 0 || streamIndex > 100) return json(res, 400, { error: "Invalid subtitle stream index" });
      const metadata = await probe(source);
      if (!metadata.streams.some(s => s.index === streamIndex && s.codecType === "subtitle")) return json(res, 400, { error: "Requested stream is not a subtitle track" });
      const child = spawn("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", source, "-map", "0:" + streamIndex, "-f", "webvtt", "pipe:1"]);
      const chunks = []; let size = 0; let stderr = "";
      child.stdout.on("data", b => { size += b.length; if (size <= 20 * 1024 * 1024) chunks.push(b); else child.kill("SIGKILL"); });
      child.stderr.on("data", b => { stderr += b.toString(); });
      const code = await new Promise(resolve => child.on("close", resolve));
      if (code !== 0 || size > 20 * 1024 * 1024) return json(res, 422, { error: "This subtitle track could not be converted to WebVTT", detail: stderr.slice(0, 300) });
      res.writeHead(200, { "content-type": "text/vtt; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
      return res.end(Buffer.concat(chunks));
    }
    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = await readJson(req);
      const source = await validateSource(String(body.url || ""));
      const activeSessions = [...sessions.values()].filter(s => s.exitCode === undefined).length;
      if (activeSessions >= 2) return json(res, 429, { error: "The media engine is busy. Retry when an active conversion finishes." });
      const info = await probe(source);
      if (!info.streams.some(s => s.codecType === "video")) return json(res, 422, { error: "No video stream was found in this source" });
      const id = randomUUID();
      const dir = path.join(ROOT, id);
      await mkdir(dir, { recursive: true });
      const playlist = path.join(dir, "index.m3u8");
      const args = [
        "-nostdin", "-hide_banner", "-loglevel", "warning", "-y", "-i", source,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-pix_fmt", "yuv420p", "-profile:v", "main", "-level", "4.0",
        "-c:a", "aac", "-b:a", "160k", "-ac", "2",
        "-f", "hls", "-hls_time", "6", "-hls_list_size", "0",
        "-hls_flags", "independent_segments+temp_file",
        "-hls_segment_filename", path.join(dir, "segment_%05d.ts"), playlist
      ];
      const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", b => { stderr = (stderr + b.toString()).slice(-4000); });
      const session = { id, dir, child, startedAt: Date.now(), stderr: () => stderr };
      sessions.set(id, session);
      child.on("close", code => { session.exitCode = code; });
      const cleanup = setTimeout(async () => {
        try { child.kill("SIGTERM"); } catch {}
        sessions.delete(id);
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }, 2 * 60 * 60 * 1000);
      cleanup.unref?.();
      const ready = await waitForPlaylist(playlist, child, 30000);
      if (!ready) {
        try { child.kill("SIGTERM"); } catch {}
        sessions.delete(id);
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        return json(res, 504, { error: "FFmpeg did not prepare the first HLS segment in time", detail: session.stderr() });
      }
      return json(res, 202, {
        id, status: "preparing",
        playlist: "/sessions/" + id + "/index.m3u8",
        streams: info.streams,
        subtitles: info.streams.filter(s => s.codecType === "subtitle")
      });
    }
    const match = url.pathname.match(/^\/sessions\/([a-f0-9-]{36})\/([a-zA-Z0-9_.-]+)$/);
    if (req.method === "GET" && match) {
      const session = sessions.get(match[1]);
      if (!session) return json(res, 404, { error: "Playback session not found or container restarted" });
      const filename = match[2];
      if (filename.includes("..") || filename.includes("/") || !/^(index\.m3u8|segment_\d{5}\.ts)$/.test(filename)) return json(res, 400, { error: "Invalid media segment path" });
      if (filename === "index.m3u8" && session.exitCode !== undefined && session.exitCode !== 0) {
        return json(res, 502, { error: "FFmpeg conversion stopped", detail: session.stderr() });
      }
      return sendFile(res, path.join(session.dir, filename));
    }
    return json(res, 404, { error: "Unknown media engine endpoint" });
  } catch (error) {
    return json(res, 400, { error: error instanceof Error ? error.message : "Media engine request failed" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("MaseNet FFmpeg Media Engine listening on " + PORT);
});
