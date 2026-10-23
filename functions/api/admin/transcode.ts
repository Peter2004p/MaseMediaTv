import { json, requireAdmin, type Env as AuthEnv } from "../auth/_shared";

interface Env extends AuthEnv { VT_API_KEY?: string; }
type Episode = { id?: string; title?: string; streamUrl?: string; qualities?: { quality?: string; streamUrl?: string }[] };
const API = "https://videotranscode.cloud/api/v1/jobs";
const PRESETS = new Set(["mp4_264_480p", "mp4_264_720p", "hls_abr_264_basic"]);

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  if (!env.VT_API_KEY) return json({ error: "Video conversion is not configured. Add the VT_API_KEY secret to this Cloudflare Pages project." }, 503);
  let input: { episodeId?: string; preset?: string; sourceUrl?: string };
  try { input = await request.json(); } catch { return json({ error: "Expected a JSON body." }, 400); }
  const episodeId = String(input.episodeId || "").trim();
  const preset = String(input.preset || "mp4_264_720p");
  if (!episodeId || episodeId.length > 200) return json({ error: "A valid episodeId is required." }, 400);
  if (!PRESETS.has(preset)) return json({ error: "Unsupported preset. Choose mp4_264_480p, mp4_264_720p, or hls_abr_264_basic." }, 400);

  const rows = await env.DB.prepare("SELECT metadata_json FROM titles").all<{ metadata_json: string }>();
  let episode: Episode | undefined;
  for (const row of rows.results || []) {
    try {
      const title = JSON.parse(row.metadata_json);
      episode = (title.episodes || []).find((e: Episode) => String(e.id) === episodeId);
      if (episode) break;
    } catch { /* Ignore malformed catalog rows. */ }
  }
  if (!episode) return json({ error: "Episode not found in the Cloudflare catalog." }, 404);
  const candidates = [episode.streamUrl, ...(episode.qualities || []).map(q => q.streamUrl)].filter((x): x is string => typeof x === "string");
  const sourceUrl = String(input.sourceUrl || candidates[0] || "");
  try {
    const source = new URL(sourceUrl);
    if (source.protocol !== "https:" || source.username || source.password || !candidates.includes(sourceUrl)) return json({ error: "Conversion source must be an HTTPS URL already assigned to this episode." }, 400);
    const host = source.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return json({ error: "Private network sources are not allowed." }, 400);
  } catch { return json({ error: "Invalid source URL." }, 400); }

  let upstream: Response;
  try {
    upstream = await fetch(API, {
      method: "POST",
      headers: { Authorization: "Bearer " + env.VT_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ inputUrl: sourceUrl, preset })
    });
  } catch { return json({ error: "The conversion service could not be reached." }, 502); }
  const body = await upstream.json().catch(() => ({})) as Record<string, unknown>;
  if (!upstream.ok) return json({ error: typeof body.message === "string" ? body.message : "Conversion service rejected the job.", providerStatus: upstream.status }, upstream.status === 429 ? 429 : 502);
  return json({ ok: true, job: body, note: "Conversion is asynchronous. Poll GET /api/admin/transcode?jobId=<job id> to check status. Free-tier jobs are limited to 10 minutes and 10 jobs per month." }, 202);
};

export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  if (!env.VT_API_KEY) return json({ error: "Video conversion is not configured. Add the VT_API_KEY secret to this Cloudflare Pages project." }, 503);
  const jobId = new URL(request.url).searchParams.get("jobId") || "";
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(jobId)) return json({ error: "A valid conversion jobId is required." }, 400);
  let upstream: Response;
  try {
    upstream = await fetch(API + "/" + encodeURIComponent(jobId), { headers: { Authorization: "Bearer " + env.VT_API_KEY } });
  } catch { return json({ error: "The conversion service could not be reached." }, 502); }
  const body = await upstream.json().catch(() => ({})) as Record<string, unknown>;
  if (!upstream.ok) return json({ error: typeof body.message === "string" ? body.message : "Could not read conversion job.", providerStatus: upstream.status }, upstream.status === 429 ? 429 : 502);
  return json({ ok: true, job: body });
};
