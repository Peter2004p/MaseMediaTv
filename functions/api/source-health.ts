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

// Admin-only, read-only HEAD checks. Never downloads movie bytes and never follows redirects.
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
      const status = response.status;
      if (status >= 200 && status < 300) {
        return { ...base, status: "reachable", httpStatus: status, contentType: response.headers.get("content-type") || "Not provided", message: "Source responded to a HEAD request." };
      }
      if (status >= 300 && status < 400) {
        return { ...base, status: "redirect", httpStatus: status, message: "Source redirects. Redirect destination was not followed; test the final direct URL." };
      }
      return { ...base, status: status >= 500 ? "server_error" : "http_error", httpStatus: status, message: "Source returned an HTTP error." };
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

  return json({ ok: true, checkedAt: new Date().toISOString(), method: "HEAD", note: "No movie or drama bytes were downloaded. Redirects were not followed.", counts, results });
};
