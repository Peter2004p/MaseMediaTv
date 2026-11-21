export function normalizeCodec(value) {
  const codec = String(value || "").toLowerCase();
  return ({ hevc: "x265", h265: "x265", h264: "x264" })[codec] || codec;
}

export function matchesKdlFileButton(buttonText, item, episodeText) {
  const tokens = String(buttonText || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const expectedQuality = String(item.quality || "").toLowerCase();
  const expectedCodec = normalizeCodec(item.codec);
  if (!expectedQuality || !expectedCodec || expectedCodec === "unknown") return false;
  if (!tokens.includes(String(episodeText || "").toLowerCase())) return false;
  if (!tokens.includes(expectedQuality)) return false;
  const codecToken = tokens.find(token => ["x265", "h265", "hevc", "x264", "h264", "av1"].includes(token));
  return !!codecToken && normalizeCodec(codecToken) === expectedCodec;
}

export function isNextPageLabel(value) {
  return /^(?:NEXT\s*»|»\s*NEXT|NEXT)$/i.test(String(value || "").trim());
}
