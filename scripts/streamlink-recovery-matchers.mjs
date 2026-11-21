export function normalizeCodec(value) {
  const codec = String(value || "").toLowerCase();
  return ({ hevc: "x265", h265: "x265", h264: "x264" })[codec] || codec;
}

export function matchesKdlFileButton(buttonText, item, episodeText) {
  const value = String(buttonText || "");
  const expectedQuality = String(item.quality || "").toLowerCase();
  const expectedCodec = normalizeCodec(item.codec);
  if (!expectedQuality || !expectedCodec || expectedCodec === "unknown") return false;
  if (!new RegExp("\\b" + episodeText.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") + "\\b", "i").test(value)) return false;
  if (!new RegExp("\\b" + expectedQuality.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") + "\\b", "i").test(value)) return false;
  const codecMatch = value.match(/\\b(x265|h265|hevc|x264|h264|av1)\\b/i)?.[1];
  return !!codecMatch && normalizeCodec(codecMatch) === expectedCodec;
}

export function isNextPageLabel(value) {
  return /^(?:NEXT\s*»|»\s*NEXT|NEXT)$/i.test(String(value || "").trim());
}
