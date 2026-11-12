export type TelegramChannelPost = { title: string; text: string; url: string; date?: string; score: number };

const decode = (value: string) => value
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

const cleanHtml = (value: string) => decode(value
  .replace(/<br\s*\/?\s*>/gi, "\n")
  .replace(/<\/(?:p|div|li|blockquote)>/gi, "\n")
  .replace(/<[^>]*>/g, ""))
  .replace(/[\t\r ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase()
  .replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export async function searchPublicTelegramChannel(query: string, limit = 5): Promise<TelegramChannelPost[]> {
  const q = normalize(query);
  if (q.length < 2) return [];
  const terms = q.split(/\\s+/).filter(Boolean);
  const results: TelegramChannelPost[] = [];
  let before = 0;
  for (let page = 0; page < 5; page++) {
    const pageUrl = "https://t.me/s/MaseMediaTv" + (before ? "?before=" + before : "");
    const response = await fetch(pageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MaseNetSearch/1.0)" },
      cf: { cacheTtl: 60, cacheEverything: true }
    } as RequestInit);
    if (!response.ok) {
      if (page === 0) throw new Error("Public Telegram channel preview is unavailable");
      break;
    }
    const html = await response.text();
    const blocks = html.match(/<div class="tgme_widget_message_wrap[\\s\\S]*?(?=<div class="tgme_widget_message_wrap|$)/gi) || [];
    let oldestId = Number.POSITIVE_INFINITY;
    for (const block of blocks) {
      const postId = block.match(/data-post="MaseMediaTv\\/(\\d+)"/i)?.[1];
      if (!postId) continue;
      oldestId = Math.min(oldestId, Number(postId));
      const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\\s\\S]*?)<\\/div>/i);
      const text = textMatch ? cleanHtml(textMatch[1]) : "";
      const title = text.split("\\n").map(line => line.trim()).find(Boolean)?.slice(0, 140) || "MaseMediaTv channel post";
      const haystack = normalize(text);
      const matched = terms.filter(term => haystack.includes(term)).length;
      const score = haystack.includes(q) ? 100 : matched;
      if (!text || score === 0) continue;
      const date = block.match(/<time[^>]+datetime="([^"]+)"/i)?.[1];
      const url = "https://t.me/MaseMediaTv/" + postId;
      if (!results.some(post => post.url === url)) results.push({ title, text: text.slice(0, 1200), url, ...(date ? { date } : {}), score });
    }
    if (!Number.isFinite(oldestId) || oldestId <= 1 || oldestId >= before) break;
    before = oldestId;
    if (results.some(post => post.score === 100) && page >= 1) break;
  }
  return results.sort((a,b) => b.score-a.score || String(b.date||"").localeCompare(String(a.date||""))).slice(0, Math.max(1, Math.min(10, limit)));
}
