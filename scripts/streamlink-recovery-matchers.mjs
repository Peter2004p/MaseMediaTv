export function stripSourceLabelSuffix(value) {
  return String(value || "").normalize("NFKC")
    .replace(/(^|[\s._+@-])(?:KDLand|KLandd|KDLAir|iQIYI|IQIYI|Youku|Youk|VIKI|Viki|VIK|IQ)(?=$|[\s._+-])/gi, " ")
    .replace(/\s+/g, " ").trim();
}

export function normalizeCodec(value) {
  const codec = String(value || "").toLowerCase();
  return ({ hevc: "x265", h265: "x265", h264: "x264" })[codec] || codec;
}

export function matchesKdlFileButton(buttonText, item, episodeText, { qualityConfirmed = false } = {}) {
  const tokens = String(buttonText || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (item.title) {
    const normalizeTitle = value => stripSourceLabelSuffix(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const expectedTitle = normalizeTitle(item.title);
    const visibleTitle = normalizeTitle(buttonText);
    if (!expectedTitle || !(" " + visibleTitle + " ").includes(" " + expectedTitle + " ")) return false;
  }
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
  // KDL Air's episode-list buttons show only file size, episode and title.
  // Codec is available on the selected Telegram document card, so defer that
  // verification until after selecting the unique episode row.
  if (!codecToken) return qualityConfirmed;
  return normalizeCodec(codecToken) === expectedCodec;
}

export function isNextPageLabel(value) {
  const normalized = String(value || "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  return /^(?:NEXT\s*»|»\s*NEXT|NEXT)$/i.test(normalized);
}

export function isKdlEpisodeRowLabel(value) {
  return /\bS\d{2}E\d{2}\b/i.test(String(value || ""));
}
