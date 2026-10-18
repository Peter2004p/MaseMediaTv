import { json } from "../auth/_shared";

interface Env { DB: D1Database; }
type Episode = { streamUrl?: unknown; qualities?: Array<{ streamUrl?: unknown }> };

export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
  const url = new URL(request.url);
  const episodeId = url.searchParams.get("episodeId") || "";
  if (!episodeId || episodeId.length > 200) return json({ error: "Missing episodeId." }, 400);

  const rows = await env.DB.prepare("SELECT metadata_json FROM titles").all<{ metadata_json: string }>();
  let episode: Episode | null = null;
  for (const row of rows.results || []) {
    try {
      const title = JSON.parse(row.metadata_json) as { episodes?: Array<{ id?: unknown } & Episode> };
      const found = (title.episodes || []).find((item) => String(item.id) === episodeId);
      if (found) { episode = found; break; }
    } catch { /* Ignore malformed legacy metadata and continue searching. */ }
  }
  if (!episode) return json({ error: "Episode not found in the Cloudflare library." }, 404);

  const sources = [episode.streamUrl, ...(episode.qualities || []).map((quality) => quality.streamUrl)]
    .filter((source): source is string => typeof source === "string" && source.length > 0);
  const source = sources.find((value) => {
    try { const parsed = new URL(value); return parsed.protocol === "https:"; } catch { return false; }
  });
  if (!source) return json({ error: "No valid HTTPS source is registered for this episode." }, 400);

  // Cloudflare Pages Functions do not transcode MKV containers. Returning a clear
  // status is safer than pretending that proxying an MKV file converts its codecs.
  return json({
    error: "MKV transcoding is not configured on this Cloudflare deployment.",
    code: "TRANSCODER_NOT_CONFIGURED",
    message: "Use an MP4/HLS source or configure a compatible transcoding service. The original AppDeploy site has not been changed."
  }, 501);
};
