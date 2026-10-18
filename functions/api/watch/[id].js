function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
export async function onRequestGet({ request, env, params }) {
  if (!env.DB) return json({ error: "Media service is not configured." }, 503);
  const id = typeof params?.id === "string" ? params.id.slice(0, 100) : "";
  if (!id) return json({ error: "Media item not found." }, 404);
  try {
    const item = await env.DB.prepare("SELECT video_url, subtitle_url FROM catalog WHERE id = ? LIMIT 1").bind(id).first();
    if (!item) return json({ error: "Media item not found." }, 404);
    const url = new URL(request.url);
    const isSubtitle = url.searchParams.get("subtitle") === "1";
    const target = isSubtitle ? item.subtitle_url : item.video_url;
    if (typeof target !== "string" || !target) return json({ error: isSubtitle ? "No subtitles are available for this title." : "Media URL is unavailable." }, 404);
    let parsed;
    try { parsed = new URL(target); } catch { return json({ error: "Stored media URL is invalid." }, 502); }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return json({ error: "Stored media URL is not permitted." }, 502);
    return new Response(null, { status: 302, headers: {
      "Location": parsed.href,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    }});
  } catch {
    return json({ error: "Media lookup failed." }, 500);
  }
}
export async function onRequest({ request }) {
  return json({ error: "Use GET to play media." }, 405);
}
