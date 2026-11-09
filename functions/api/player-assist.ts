interface Env { GEMINI_API_KEY?: string; GEMINI_MODEL?: string; }
type Diagnostics = {
  sourceType?: unknown; time?: unknown; duration?: unknown; buffering?: unknown;
  playing?: unknown; error?: unknown; hls?: unknown; mkv?: unknown;
  subtitleTrackCount?: unknown; readyState?: unknown; networkState?: unknown;
  videoErrorCode?: unknown;
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
const safeNumber = (value: unknown, max = 10000000) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
};
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  if (!env.GEMINI_API_KEY) return json({ error: "Gemini is not connected yet. Add GEMINI_API_KEY as a Cloudflare Pages secret, then redeploy." }, 503);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Request origin is not allowed." }, 403);
  const body = await request.json().catch(() => null) as { question?: unknown; diagnostics?: Diagnostics } | null;
  if (!body) return json({ error: "Invalid request body." }, 400);
  const question = String(body.question || "Diagnose the current video player state.").trim().slice(0, 700);
  if (!question) return json({ error: "Please enter a question for Gemini." }, 400);
  const raw = body.diagnostics || {};
  // Send only playback facts. Never send the signed stream URL, cookies, account details, or video bytes.
  const diagnostics = {
    sourceType: String(raw.sourceType || "Unknown").slice(0, 30),
    currentTimeSeconds: safeNumber(raw.time, 10000000),
    durationSeconds: safeNumber(raw.duration, 10000000),
    buffering: Boolean(raw.buffering),
    playing: Boolean(raw.playing),
    error: String(raw.error || "").slice(0, 500),
    hls: Boolean(raw.hls),
    mkv: Boolean(raw.mkv),
    subtitleTrackCount: Math.round(safeNumber(raw.subtitleTrackCount, 100)),
    readyState: Math.round(safeNumber(raw.readyState, 4)),
    networkState: Math.round(safeNumber(raw.networkState, 3)),
    videoErrorCode: raw.videoErrorCode == null ? null : Math.round(safeNumber(raw.videoErrorCode, 4))
  };
  const prompt = [
    "You are Gemini, the playback troubleshooting assistant inside MaseNet.",
    "Use the supplied player diagnostics and the user's question. Explain likely causes in plain language and give one or two safe, practical next steps.",
    "Be honest about uncertainty. Do not claim to have changed settings, repaired the stream, or inspected video content. Do not assume a stream is expired unless the diagnostics prove it.",
    "Explain browser codec/container limitations accurately. HLS network failures may be caused by playlist, segment, CDN, or signed-link problems. MKV support depends on the browser/player decoder.",
    "Keep the answer concise and focused on this playback session.",
    "Player diagnostics (JSON): " + JSON.stringify(diagnostics),
    "User question: " + question
  ].join("\n\n");
  const model = String(env.GEMINI_MODEL || "gemini-2.5-flash").trim().replace(/^models\//, "");
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: "You are a careful video playback support assistant. Never invent diagnostics or claim to control the player." }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.25, maxOutputTokens: 500 }
      })
    });
    const data = await response.json().catch(() => ({})) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      console.error("Gemini Player API error", response.status, data.error?.message || "No provider message");
      if (response.status === 429) return json({ error: "Gemini is busy right now. Please wait a moment and try again." }, 429);
      if (response.status === 401 || response.status === 403) return json({ error: "Gemini rejected the API key. Check the GEMINI_API_KEY secret in Cloudflare." }, 502);
      return json({ error: "Gemini could not analyse this player request. Please try again shortly." }, 502);
    }
    const text = (data.candidates || []).flatMap(candidate => candidate.content?.parts || []).map(part => part.text || "").join("\n").trim();
    if (!text) return json({ error: "Gemini returned an empty diagnosis. Please try again." }, 502);
    return json({ text: text.slice(0, 4000), model });
  } catch (error) {
    console.error("Gemini Player request failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: "Could not reach Gemini. Check the connection and try again." }, 502);
  }
};
