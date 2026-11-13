const CHANNEL_ID = "UCT8yUxTnY1d-arihLSCJfEA";
const CHANNEL_URL = "https://www.youtube.com/@masemedia_tv/videos";

const decodeXml = (value: string) => value
 .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
 .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
 .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
 .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const tag = (xml: string, name: string) => {
 const match = xml.match(new RegExp("<(?:[\\w-]+:)?" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?" + name + ">","i"));
 return match ? decodeXml(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()) : "";
};

function extractVideoRenderers(html: string) {
 const marker = '"videoRenderer":';
 const videos: Array<{id:string;title:string;published:string;url:string;thumbnail:string}> = [];
 let cursor = 0;
 while (videos.length < 30) {
  const found = html.indexOf(marker, cursor);
  if (found < 0) break;
  let start = found + marker.length;
  while (/\\s/.test(html[start] || "")) start++;
  if (html[start] !== "{") { cursor = start + 1; continue; }
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let i = start; i < html.length; i++) {
   const ch = html[i];
   if (inString) {
    if (escaped) escaped = false;
    else if (ch === "\\\\") escaped = true;
    else if (ch === '"') inString = false;
    continue;
   }
   if (ch === '"') inString = true;
   else if (ch === "{") depth++;
   else if (ch === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) break;
  cursor = end;
  try {
   const item = JSON.parse(html.slice(start, end));
   const id = typeof item.videoId === "string" ? item.videoId : "";
   if (!/^[A-Za-z0-9_-]{11}$/.test(id) || videos.some(v => v.id === id)) continue;
   const title = item.title?.runs?.map((r:any) => r.text || "").join("") || item.title?.simpleText || "MaseMediaTv video";
   const published = item.publishedTimeText?.simpleText || "";
   const thumbs = item.thumbnail?.thumbnails || [];
   const thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg";
   videos.push({ id, title, published, url: "https://www.youtube.com/watch?v=" + id, thumbnail });
  } catch { /* Ignore malformed renderer fragments and continue scanning. */ }
 }
 return videos;
}

export const onRequestGet: PagesFunction = async () => {
 try {
  // Prefer YouTube's official Atom feeds, then scrape the public channel videos page
  // as a read-only fallback so the app still receives a list rather than one hardcoded item.
  const uploadsPlaylistId = "UU" + CHANNEL_ID.slice(2);
  const feedUrls = [
   "https://www.youtube.com/feeds/videos.xml?channel_id=" + CHANNEL_ID,
   "https://www.youtube.com/feeds/videos.xml?playlist_id=" + uploadsPlaylistId
  ];
  let xml = "";
  for (const feedUrl of feedUrls) {
   try {
    const upstream = await fetch(feedUrl, {
     headers: { "Accept": "application/atom+xml, application/xml, text/xml", "User-Agent": "Mozilla/5.0 (compatible; MaseMediaTv/1.0)" },
     cf: { cacheTtl: 120, cacheEverything: true }
    });
    if (!upstream.ok) continue;
    const candidate = await upstream.text();
    if (candidate.includes("<feed") && candidate.includes("<entry")) { xml = candidate; break; }
   } catch { /* Try the next public endpoint. */ }
  }

  if (xml) {
   const entries = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
   const videos = entries.map((entry) => {
    const id = tag(entry, "videoId") || (entry.match(/<id>yt:video:([^<]+)<\/id>/i)?.[1] || "");
    const title = tag(entry, "title");
    const published = tag(entry, "published");
    const href = entry.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] || ("https://www.youtube.com/watch?v=" + id);
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return { id, title, published, url: href, thumbnail: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg" };
   }).filter((item): item is NonNullable<typeof item> => !!item);
   if (videos.length) {
    return new Response(JSON.stringify({ channelTitle: "MaseMediaTv", videos, channelId: CHANNEL_ID, refreshedAt: new Date().toISOString() }), {
     headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600" }
    });
   }
  }

  // RSS can be unavailable even while the public channel page is accessible.
  try {
   const page = await fetch(CHANNEL_URL, {
    headers: { "Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36" },
    cf: { cacheTtl: 180, cacheEverything: true }
   });
   if (page.ok) {
    const html = await page.text();
    const videos = extractVideoRenderers(html);
    if (videos.length) {
     return new Response(JSON.stringify({ channelTitle: "MaseMediaTv", videos, channelId: CHANNEL_ID, feedFallback: true, feedWarning: "Loaded the public channel uploads page because the RSS feed was unavailable.", refreshedAt: new Date().toISOString() }), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60, s-maxage=180, stale-while-revalidate=300" }
     });
    }
   }
  } catch { /* Use the safe last-resort item below. */ }

  // Last resort only: a single owner-supplied video, never presented as a full feed.
  const fallbackVideoId = "UPRUHUTl1NI";
  return new Response(JSON.stringify({
   channelTitle: "MaseMediaTv",
   channelId: CHANNEL_ID,
   videos: [{
    id: fallbackVideoId,
    title: "Watch MaseMediaTv",
    published: "",
    url: "https://www.youtube.com/shorts/" + fallbackVideoId,
    thumbnail: "https://i.ytimg.com/vi/" + fallbackVideoId + "/hqdefault.jpg"
   }],
   feedFallback: true,
   feedWarning: "YouTube's public feeds are unavailable. Showing one fallback video until uploads can be retrieved.",
   refreshedAt: new Date().toISOString()
  }), {
   headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=30, s-maxage=60" }
  });
 } catch (error) {
  return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unable to load the YouTube channel feed." }), {
   status: 502, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
 }
};
