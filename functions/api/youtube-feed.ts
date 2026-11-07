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
  const upstream = await fetch("https://www.youtube.com/feeds/videos.xml?channel_id=" + CHANNEL_ID, {
   headers: { "Accept": "application/atom+xml, application/xml, text/xml", "User-Agent": "MaseMediaTv/1.0" },
   cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!upstream.ok) throw new Error("YouTube feed returned HTTP " + upstream.status);
  const xml = await upstream.text();
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
