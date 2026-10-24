import { json, requireAdmin, type Env as AuthEnv } from "../auth/_shared";

interface Env extends AuthEnv { VT_API_KEY?: string; MEDIA_BUCKET?: R2Bucket; }
type Job = { id?: string; status?: string; inputUrl?: string; outputUrl?: string | null; errorMessage?: string | null; preset?: string; duration?: number };
type Variant = { quality?: string; streamUrl?: string; mimeType?: string; [key: string]: unknown };
type Episode = { id?: string; quality?: string; streamUrl?: string; qualities?: Variant[]; originalStreamUrl?: string; originalQualities?: Variant[]; [key: string]: unknown };
const API = "https://videotranscode.cloud/api/v1/jobs";
const MAX_BYTES = 1_500_000_000;

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  if (!env.VT_API_KEY) return json({ error: "Video conversion is not configured. Add the VT_API_KEY secret to Cloudflare Pages." }, 503);
  if (!env.MEDIA_BUCKET) return json({ error: "Permanent video storage is not configured. The MEDIA_BUCKET R2 binding is missing." }, 503);

  let input: { episodeId?: string; jobId?: string };
  try { input = await request.json(); } catch { return json({ error: "Expected a JSON body." }, 400); }
  const episodeId = String(input.episodeId || "").trim();
  const jobId = String(input.jobId || "").trim();
  if (!episodeId || episodeId.length > 200 || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(jobId)) return json({ error: "A valid episodeId and conversion jobId are required." }, 400);

  const rows = await env.DB.prepare("SELECT id, metadata_json FROM titles").all<{ id: string; metadata_json: string }>();
  let owner: { id: string; title: Record<string, any>; episode: Episode } | undefined;
  for (const row of rows.results || []) {
    try {
      const title = JSON.parse(row.metadata_json) as Record<string, any>;
      const episode = (title.episodes || []).find((item: Episode) => String(item.id) === episodeId) as Episode | undefined;
      if (episode) { owner = { id: row.id, title, episode }; break; }
    } catch { /* Ignore malformed catalog rows. */ }
  }
  if (!owner) return json({ error: "Episode not found in the Cloudflare catalog." }, 404);

  let jobResponse: Response;
  try { jobResponse = await fetch(API + "/" + encodeURIComponent(jobId), { headers: { Authorization: "Bearer " + env.VT_API_KEY } }); }
  catch { return json({ error: "The conversion service could not be reached." }, 502); }
  const job = await jobResponse.json().catch(() => ({})) as Job;
  if (!jobResponse.ok) return json({ error: job.errorMessage || "Could not verify conversion job.", providerStatus: jobResponse.status }, jobResponse.status === 429 ? 429 : 502);
  if (job.status !== "completed" || !job.outputUrl) return json({ error: job.errorMessage || "The conversion job is not completed or has no output yet.", status: job.status || "unknown" }, 409);

  const episode = owner.episode;
  const allowedSources = [
    episode.streamUrl,
    episode.originalStreamUrl,
    ...(episode.qualities || []).map(v => v.streamUrl),
    ...(episode.originalQualities || []).map(v => v.streamUrl)
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  if (!job.inputUrl || !allowedSources.includes(job.inputUrl)) return json({ error: "This conversion job's source does not match the selected episode." }, 403);

  let output: URL;
  try {
    output = new URL(job.outputUrl);
    if (output.protocol !== "https:" || output.username || output.password || !output.hostname.toLowerCase().endsWith(".digitaloceanspaces.com")) {
      return json({ error: "The conversion provider returned an unsupported output host." }, 502);
    }
  } catch { return json({ error: "The conversion provider returned an invalid output URL." }, 502); }

  let upstream: Response;
  try { upstream = await fetch(output.toString(), { redirect: "follow" }); }
  catch { return json({ error: "Could not download the converted video from the provider." }, 502); }
  if (!upstream.ok || !upstream.body) return json({ error: "The provider output could not be downloaded.", providerStatus: upstream.status }, 502);
  const size = Number(upstream.headers.get("content-length") || 0);
  if (!Number.isFinite(size) || size <= 0) { await upstream.body.cancel(); return json({ error: "The provider did not return a usable file size; nothing was saved." }, 502); }
  if (size > MAX_BYTES) { await upstream.body.cancel(); return json({ error: "Converted files must be 1.5 GB or smaller for this import route." }, 413); }

  const preset = String(job.preset || "");
  if (!preset.startsWith("mp4_")) { await upstream.body.cancel(); return json({ error: "Permanent import currently supports MP4 outputs only. HLS packaging needs a separate playlist-and-segment import." }, 400); }
  const quality = preset.includes("480p") ? "480p" : "720p";
  const objectPath = "videos/" + owner.id.replace(/[^a-zA-Z0-9_-]/g, "") + "/" + episodeId.replace(/[^a-zA-Z0-9_-]/g, "") + "-" + crypto.randomUUID() + ".mp4";

  try {
    await env.MEDIA_BUCKET.put(objectPath, upstream.body, {
      httpMetadata: { contentType: "video/mp4", cacheControl: "public, max-age=86400" },
      customMetadata: { titleId: owner.id, episodeId, sourceJobId: jobId, quality }
    });
  } catch {
    return json({ error: "R2 could not store the converted video. Check bucket limits and storage configuration." }, 502);
  }

  const streamUrl = new URL("/api/media/file?path=" + encodeURIComponent(objectPath), new URL(request.url).origin).toString();
  const current = owner.episode;
  const previousStream = current.originalStreamUrl || current.streamUrl;
  const previousQualities = current.originalQualities || current.qualities;
  const oldVariants = current.qualities || (current.streamUrl ? [{ quality: current.quality || "720p", streamUrl: current.streamUrl, mimeType: typeof current.mimeType === "string" ? current.mimeType : undefined }] : []);
  const converted: Variant = { quality, streamUrl, mimeType: "video/mp4", converted: true, storagePath: objectPath };
  const nextVariants = [converted, ...oldVariants.filter(v => v.quality !== quality && v.streamUrl !== streamUrl)];
  current.originalStreamUrl = previousStream;
  if (previousQualities) current.originalQualities = previousQualities;
  current.streamUrl = streamUrl;
  current.streamPath = objectPath;
  current.mimeType = "video/mp4";
  current.quality = quality;
  current.qualities = nextVariants;

  try {
    await env.DB.prepare("UPDATE titles SET metadata_json=?, updated_at=datetime('now') WHERE id=?")
      .bind(JSON.stringify(owner.title), owner.id).run();
  } catch {
    await env.MEDIA_BUCKET.delete(objectPath).catch(() => undefined);
    return json({ error: "The file was uploaded, but the catalog could not be updated. The temporary R2 object was cleaned up; retry the import." }, 500);
  }

  return json({ ok: true, episodeId, quality, streamUrl, storagePath: objectPath, bytes: size, message: "Converted MP4 saved in R2 and added to this episode. The original source URL was retained in episode metadata." });
};
