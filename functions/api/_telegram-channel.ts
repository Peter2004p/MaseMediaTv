export type TelegramChannelPost = { title: string; text: string; url: string; date?: string; score: number };

type TelegramChannelMessage = {
  message_id?: number;
  date?: number;
  chat?: { username?: string };
  text?: string;
  caption?: string;
};

async function ensureChannelIndex(db: D1Database) {
  await db.prepare(\`CREATE TABLE IF NOT EXISTS telegram_channel_posts (
    post_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    post_text TEXT NOT NULL,
    post_date TEXT,
    post_url TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )\`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_telegram_channel_posts_date ON telegram_channel_posts(post_date)").run();
}

export async function indexTelegramChannelPost(db: D1Database, message: TelegramChannelMessage): Promise<boolean> {
  if (String(message.chat?.username || "").toLowerCase() !== "masemediatv") return false;
  const postId = Number(message.message_id || 0);
  const postText = String(message.text || message.caption || "").trim().slice(0, 12000);
  if (!postId || !postText) return false;
  await ensureChannelIndex(db);
  const title = postText.split("\n").map(line => line.trim()).find(Boolean)?.slice(0, 140) || "MaseMediaTv channel post";
  const date = message.date ? new Date(message.date * 1000).toISOString() : null;
  const url = "https://t.me/MaseMediaTv/" + postId;
  await db.prepare(\`INSERT INTO telegram_channel_posts (post_id,title,post_text,post_date,post_url,updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(post_id) DO UPDATE SET
      title=excluded.title,
      post_text=excluded.post_text,
      post_date=excluded.post_date,
      post_url=excluded.post_url,
      updated_at=datetime('now')\`)
    .bind(String(postId), title, postText, date, url).run();
  return true;
}

export async function searchIndexedTelegramChannel(db: D1Database, query: string, limit = 5): Promise<TelegramChannelPost[]> {
  const normalized = query.normalize("NFKC").toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (normalized.length < 2) return [];
  await ensureChannelIndex(db);
  const stopWords = new Set(["the","and","for","with","from","that","this","what","where","when","how","can","you","me","please","show","find","search","look","looking","available","movie","movies","drama","dramas","episode","episodes","season","recommend","watch","want","need","is","are","in","on","of","to","a","an","do","have"]);
  const terms = normalized.split(/\s+/).filter(term => term.length > 1 && !stopWords.has(term)).slice(0, 8);
  if (!terms.length) return [];
  const where = terms.map(() => "post_text LIKE ?").join(" OR ");
  const rows = await db.prepare("SELECT title,post_text,post_date,post_url FROM telegram_channel_posts WHERE " + where + " ORDER BY post_date DESC LIMIT 200")
    .bind(...terms.map(term => "%" + term.replace(/[%_\\]/g, "\\$&") + "%"))
    .all<{title:string;post_text:string;post_date:string|null;post_url:string}>();
  return (rows.results || []).map(row => {
    const haystack = row.post_text.normalize("NFKC").toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ");
    const matched = terms.filter(term => haystack.includes(term)).length;
    const score = haystack.includes(normalized) ? 100 : matched;
    return {
      title: row.title,
      text: row.post_text.slice(0, 1200),
      url: row.post_url,
      ...(row.post_date ? { date: row.post_date } : {}),
      score
    };
  }).filter(post => post.score > 0)
    .sort((a, b) => b.score - a.score || String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, Math.max(1, Math.min(10, limit)));
}

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

export async function searchPublicTelegramChannel(query: string, limit = 5, db?: D1Database): Promise<TelegramChannelPost[]> {
  const q = normalize(query);
  if (q.length < 2) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const results: TelegramChannelPost[] = db ? await searchIndexedTelegramChannel(db, query, limit).catch(() => []) : [];
  let before = 0;

  for (let page = 0; page < 5; page++) {
    const pageUrl = "https://t.me/s/MaseMediaTv" + (before ? "?before=" + before : "");
    const response = await fetch(pageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MaseNetSearch/1.0)" },
      cf: { cacheTtl: 60, cacheEverything: true }
    } as RequestInit);
    if (!response.ok) {
      if (page === 0 && results.length === 0) throw new Error("Public Telegram channel preview is unavailable");
      break;
    }

    const html = await response.text();
    const blocks = html.match(/<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|$)/gi) || [];
    let oldestId = Number.POSITIVE_INFINITY;

    for (const block of blocks) {
      const postId = block.match(/data-post="MaseMediaTv\/(\d+)"/i)?.[1];
      if (!postId) continue;
      oldestId = Math.min(oldestId, Number(postId));
      const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const postText = textMatch ? cleanHtml(textMatch[1]) : "";
      const title = postText.split("\n").map(line => line.trim()).find(Boolean)?.slice(0, 140) || "MaseMediaTv channel post";
      const haystack = normalize(postText);
      const matched = terms.filter(term => haystack.includes(term)).length;
      const score = haystack.includes(q) ? 100 : matched;
      if (!postText || score === 0) continue;

      const date = block.match(/<time[^>]+datetime="([^"]+)"/i)?.[1];
      const url = "https://t.me/MaseMediaTv/" + postId;
      if (!results.some(post => post.url === url)) {
        results.push({ title, text: postText.slice(0, 1200), url, ...(date ? { date } : {}), score });
      }
    }

    if (!Number.isFinite(oldestId) || oldestId <= 1 || (before > 0 && oldestId >= before)) break;
    before = oldestId;
    if (results.some(post => post.score === 100) && page >= 1) break;
  }

  return results.sort((a, b) => b.score - a.score || String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, Math.max(1, Math.min(10, limit)));
}
