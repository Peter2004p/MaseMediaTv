import { json, requireAdmin, type Env } from "./auth/_shared";

type SourceInput = { id?: unknown; url?: unknown; title?: unknown; episode?: unknown };

const isPrivateIpv4 = (host: string) => {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a,b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
};

const safeExternalUrl = (value: unknown): URL | null => {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:") ||
      isPrivateIpv4(host)) return null;
    return url;
  } catch { return null; }
};

// Admin-only checks. HEAD is preferred; a one-byte Range GET is used as a fallback for servers that reject or fail HEAD. The response body is cancelled immediately and redirects are never followed.
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;

  let body: { sources?: SourceInput[] };
  try { body = await request.json() as { sources?: SourceInput[] }; }
  catch { return json({ error: "Send a valid JSON source list." }, 400); }

  if (!Array.isArray(body.sources) || body.sources.length < 1 || body.sources.length > 30) {
    return json({ error: "Check between 1 and 30 sources at a time." }, 400);
  }

  const results = await Promise.all(body.sources.map(async (source, index) => {
    const url = safeExternalUrl(source.url);
    const base = {
      id: String(source.id ?? index).slice(0, 120),
      title: String(source.title ?? "Untitled").slice(0, 160),
      episode: String(source.episode ?? "").slice(0, 60),
      host: url?.hostname ?? "Invalid URL"
    };
    if (!url) return { ...base, status: "invalid", message: "Not a permitted external HTTPS URL." };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url.toString(), {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "MaseNet-Source-Health/1.0" }
      });
      let status = response.status;
      let contentType = response.headers.get("content-type") || "Not provided";
      if (status >= 200 && status < 300) {
        const disposition = response.headers.get("content-disposition") || "";
        const acceptRanges = response.headers.get("accept-ranges") || "Not declared";
        const detectedFormat = /\.mkv(?:$|[?#])/i.test(url.pathname) || /matroska/i.test(contentType) || /\.mkv/i.test(disposition) ? "MKV" : /\.mp4(?:$|[?#])/i.test(url.pathname) || /video\/mp4/i.test(contentType) ? "MP4" : /\.m3u8(?:$|[?#])/i.test(url.pathname) || /mpegurl/i.test(contentType) ? "HLS" : "Unknown";
        return { ...base, status: "reachable", method: "HEAD", httpStatus: status, contentType, acceptRanges, detectedFormat, contentLength: response.headers.get("content-length") || "Not provided", message: "Source responded to HEAD. This is a candidate only; browser playback and codec compatibility are not confirmed." };
      }
      if (status >= 300 && status < 400) {
        return { ...base, status: "redirect", method: "HEAD", httpStatus: status, message: "Source redirects. Redirect destination was not followed; test the final direct URL." };
      }

      // Some file hosts return 500/405/501 to HEAD but support byte-range GET.
      // Never consume the body: cancel as soon as response headers arrive.
      if (status === 405 || status === 501 || status >= 500) {
        const rangeController = new AbortController();
        const rangeTimer = setTimeout(() => rangeController.abort(), 5000);
        try {
          const ranged = await fetch(url.toString(), {
            method: "GET",
            headers: { "Range": "bytes=0-0", "User-Agent": "MaseNet-Source-Health/1.0" },
            redirect: "manual",
            signal: rangeController.signal
          });
          status = ranged.status;
          contentType = ranged.headers.get("content-type") || contentType;
          try { await ranged.body?.cancel(); } catch { /* body cancellation is best-effort */ }
          if (status === 206) {
            const acceptRanges = ranged.headers.get("accept-ranges") || "Not declared";
            const detectedFormat = /\.mkv(?:$|[?#])/i.test(url.pathname) || /matroska/i.test(contentType) ? "MKV" : /\.mp4(?:$|[?#])/i.test(url.pathname) || /video\/mp4/i.test(contentType) ? "MP4" : /\.m3u8(?:$|[?#])/i.test(url.pathname) || /mpegurl/i.test(contentType) ? "HLS" : "Unknown";
            return { ...base, status: "range_reachable", method: "GET Range", httpStatus: status, contentType, acceptRanges, detectedFormat, contentRange: ranged.headers.get("content-range") || "Not provided", message: "Provider accepted a byte-range request. Response body was cancelled; playback is not confirmed." };
          }
          if (status >= 200 && status < 300) {
            return { ...base, status: "range_reachable", method: "GET Range", httpStatus: status, contentType, message: "Provider responded to Range GET but did not confirm partial content. Response body was cancelled; playback is not confirmed." };
          }
          if (status >= 300 && status < 400) {
            return { ...base, status: "redirect", method: "GET Range", httpStatus: status, message: "Provider redirects on Range GET. Redirect destination was not followed." };
          }
          return { ...base, status: status >= 500 ? "server_error" : "http_error", method: "GET Range", httpStatus: status, message: "Provider also returned an HTTP error to the Range GET fallback." };
        } catch (error) {
          const timedOut = error instanceof Error && error.name === "AbortError";
          return { ...base, status: timedOut ? "timeout" : "unreachable", method: "GET Range", message: timedOut ? "Range GET did not respond within 5 seconds." : "Could not reach this source with a Range GET fallback." };
        } finally {
          clearTimeout(rangeTimer);
        }
      }
      return { ...base, status: "http_error", method: "HEAD", httpStatus: status, message: "Source returned an HTTP error." };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return { ...base, status: timedOut ? "timeout" : "unreachable", message: timedOut ? "Source did not respond within 5 seconds." : "Could not reach this source from MaseNet." };
    } finally {
      clearTimeout(timer);
    }
  }));

  const counts = results.reduce((out, item) => {
    out[item.status] = (out[item.status] || 0) + 1;
    return out;
  }, {} as Record<string, number>);

  return json({ ok: true, checkedAt: new Date().toISOString(), method: "HEAD with one-byte Range GET fallback", note: "The checker cancels each Range GET response immediately after headers. It does not intentionally consume video bytes or follow redirects.", counts, results });
};
