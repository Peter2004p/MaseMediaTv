export function stripSourceLabelSuffix(value) {\n  return String(value || "").normalize("NFKC")\n    .replace(/(^|[\\s._+@-])(?:KDLand|KLandd|KDLAir|iQIYI|IQIYI|Youku|Youk|VIKI|Viki|VIK|IQ)(?=$|[\\s._+-])/gi, " ")\n    .replace(/\\s+/g, " ").trim();\n}\n\nexport function normalizeCodec(value) {
  const codec = String(value || "").toLowerCase();
  return ({ hevc: "x265", h265: "x265", h264: "x264" })[codec] || codec;
}

export function matchesKdlFileButton(buttonText, item, episodeText, { qualityConfirmed = false } = {}) {
  const tokens = String(buttonText || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const expectedQuality = String(item.quality || "").toLowerCase();
  const expectedCodec = normalizeCodec(item.codec);
  if (!expectedQuality || !expectedCodec || expectedCodec === "unknown") return false;
  if (!tokens.includes(String(episodeText || "").toLowerCase())) return false;
  if (tokens.includes(expectedQuality)) {
    // Explicit filename quality must agree with the catalogue.
  } else if (!qualityConfirmed) {
    return false;
  }
  const codecToken = tokens.find(token => ["x265", "h265", "hevc", "x264", "h264", "av1"].includes(token));
  return !!codecToken && normalizeCodec(codecToken) === expectedCodec;
}

export function isNextPageLabel(value) {
  const normalized = String(value || "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  return /^(?:NEXT\s*»|»\s*NEXT|NEXT)$/i.test(normalized);
}
