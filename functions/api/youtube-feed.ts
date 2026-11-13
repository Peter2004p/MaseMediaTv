const CHANNEL_ID = "UCT8yUxTnY1d-arihLSCJfEA";
const decodeXml = (value: string) => value
 .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
 .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
 .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
 .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const tag = (xml: string, name: string) => {
 const match = xml.match(new RegExp("<(?:[\\w-]+:)?" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?" + name + ">","i"));
 return match ? decodeXml(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()) : "";
};
export const onRequestGet: PagesFunction = async () => {
 try {
  // YouTube's channel RSS endpoint can intermittently return 404 at the edge.
  // The channel's uploads playlist is the same public feed with UC -> UU.
  // Try both endpoints before returning an error to the app.
  const uploadsPlaylistId = "UU" + CHANNEL_ID.slice(2);
  const feedUrls = [
   "https://www.youtube.com/feeds/videos.xml?channel_id=" + CHANNEL_ID,
   "https://www.youtube.com/feeds/videos.xml?playlist_id=" + uploadsPlaylistId
  ];
  let xml = "";
  let lastStatus = 0;
  for (const feedUrl of feedUrls) {
   try {
    const upstream = await fetch(feedUrl, {
     headers: { "Accept": "application/atom+xml, application/xml, text/xml", "User-Agent": "Mozilla/5.0 (compatible; MaseMediaTv/1.0; +https://masetv-cloudflare-migration.pages.dev)" },
     cf: { cacheTtl: 120, cacheEverything: true }
    });
    if (!upstream.ok) { lastStatus = upstream.status; continue; }
    const candidate = await upstream.text();
    if (candidate.includes("<feed") && candidate.includes("<entry")) { xml = candidate; break; }
    lastStatus = 502;
   } catch { lastStatus = 502; }
  }
  if (!xml) {
   // Keep the MaseMediaTv page useful when YouTube RSS is temporarily unavailable.
   // This is a real Short supplied by the channel owner; automatic uploads resume
   // as soon as either public feed becomes reachable again.
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
    feedWarning: "The live YouTube uploads feed is temporarily unavailable. Showing a verified channel video instead.",
    refreshedAt: new Date().toISOString()
   }), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60, s-maxage=120, stale-while-revalidate=300" }
   });
  }
  const entries = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  const videos = entries.map((entry) => {
   const id = tag(entry, "videoId") || (entry.match(/<id>yt:video:([^<]+)<\/id>/i)?.[1] || "");
   const title = tag(entry, "title");
   const published = tag(entry, "published");
   const href = entry.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] || ("https://www.youtube.com/watch?v=" + id);
   if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
   return { id, title, published, url: href, thumbnail: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg" };
  }).filter((item): item is NonNullable<typeof item> => !!item);
  const channelTitle = tag(xml, "name") || "MaseMediaTv";
  return new Response(JSON.stringify({ channelTitle, videos, channelId: CHANNEL_ID, refreshedAt: new Date().toISOString() }), {
   headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600" }
  });
 } catch (error) {
  return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unable to load the YouTube channel feed." }), {
   status: 502, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
 }
};
