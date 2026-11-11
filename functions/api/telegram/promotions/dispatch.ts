interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  ADMIN_TELEGRAM_CHAT_ID?: string;
  TELEGRAM_PROMO_CRON_SECRET?: string;
  GEMINI_API_KEY?: string;
  TELEGRAM_WEBAPP_URL?: string;
  TELEGRAM_MINI_APP_URL?: string;
}

type PromoTitle = { name: string; kind: string; year: number | null; description: string; poster_url: string; metadata_json: string };
type NewsItem = { title: string; link: string; summary: string; published: string; key: string };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const MINI_APP_URL = "https://t.me/MaseTv_Bot?startapp=home";

function decodeXml(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}
function cleanText(value: string) {
  return decodeXml(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function tagValue(xml: string, tag: string) {
  const match = xml.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i"));
  return match ? cleanText(match[1]) : "";
}
async function hashKey(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).slice(0, 12).map(v => v.toString(16).padStart(2, "0")).join("");
}

async function fetchEntertainmentNews(): Promise<NewsItem[]> {
  const feeds = [
    "https://news.google.com/rss/search?q=upcoming+Chinese+drama+release+date+2026+OR+2027&hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/search?q=Chinese+drama+casting+premiere+release+announcement&hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/search?q=Asian+film+and+television+new+movie+drama+release&hl=en-US&gl=US&ceid=US:en"
  ];
  const responses = await Promise.all(feeds.map(async url => {
    try {
      const response = await fetch(url, { headers: { "user-agent": "MaseNet-Entertainment-Updates/1.0" }, signal: AbortSignal.timeout(6500) });
      return response.ok ? await response.text() : "";
    } catch (error) {
      console.warn("Entertainment feed unavailable:", error instanceof Error ? error.message : String(error));
      return "";
    }
  }));
  const items: NewsItem[] = [];
  for (const xml of responses) {
    const blocks = xml.match(new RegExp("<item(?:\\\\s[^>]*)?>[\\\\s\\\\S]*?</item>", "gi")) || [];
    for (const block of blocks) {
      const title = tagValue(block, "title");
      const link = tagValue(block, "link");
      const summary = tagValue(block, "description").slice(0, 500);
      const published = tagValue(block, "pubDate");
      if (!title || !/^https:\/\//i.test(link)) continue;
      if (!/(drama|film|movie|series|premiere|release|casting|chinese|cdrama|asian)/i.test(title)) continue;
      const key = "news:" + await hashKey(link);
      items.push({ title, link, summary, published, key });
    }
  }
  return Array.from(new Map(items.map(item => [item.key, item])).values());
}

async function generateCatalogueCaption(env: Env, title: string, description: string, kind: string, year: string) {
  const fallback = `🎬 Now showing on MaseNet: ${title}${year ? ` (${year})` : ""}\n\n${description.slice(0, 430)}\n\nTap below to open MaseNet and start watching.`;
  if (!env.GEMINI_API_KEY) return fallback;
  const prompt = `Write a truthful, engaging Telegram promotion for this MaseNet ${kind}. Title: ${title}. Year: ${year || "not listed"}. Synopsis: ${description}. Use only supplied facts; invent no actors, awards, episodes or availability. Max 600 characters, plain text, no URLs.`;
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.65, maxOutputTokens: 200 } }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("Gemini catalogue caption HTTP " + response.status);
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const result = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n").trim();
  return result ? result.replace(/https?:\/\/[^\s<>]+/gi, "").slice(0, 700) : fallback;
}

async function generateNewsCaption(env: Env, item: NewsItem) {
  const summary = item.summary || "The linked report contains the details.";
  const parsedDate = item.published ? new Date(item.published) : null;\n  const date = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString().slice(0, 10) : "";
  const fallback = `📰 Entertainment update\n\n${item.title}\n\n${summary.slice(0, 360)}\n\nThis is a report from an external publisher. Check the source for the full details and confirmation.`;
  if (!env.GEMINI_API_KEY) return fallback;
  const prompt = `Create a concise Telegram entertainment-news update from this source only. Headline: ${item.title}. Publisher snippet: ${summary}. Published: ${date || "date not supplied"}. Attribute claims to the report, do not present unconfirmed release dates or casting as confirmed, do not add facts, and do not claim MaseNet has the title. End by inviting readers to discuss it. Max 600 characters, plain text, no URLs.`;
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.55, maxOutputTokens: 200 } }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("Gemini news caption HTTP " + response.status);
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const result = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n").trim();
  return result ? result.replace(/https?:\/\/[^\s<>]+/gi, "").slice(0, 700) : fallback;
}

async function generateSocialPack(env: Env, title: string, facts: string, contentType: string, sourceUrl = "") {
  const fallback = `SOCIAL MEDIA DRAFTS — ${title}

YOUTUBE
Title: ${title} | MaseNet entertainment update
Description: ${facts.slice(0, 420)}${sourceUrl ? "\nSource: " + sourceUrl : ""}

FACEBOOK
${title} — ${facts.slice(0, 320)}${sourceUrl ? "\nRead the report: " + sourceUrl : ""}

TIKTOK
${title} 👀 What do you think? Share your opinion below. #MaseNet #Movies #Drama #ChineseDrama`;
  if (!env.GEMINI_API_KEY) return fallback;
  const prompt = `Prepare a ready-to-edit social media content pack for MaseNet. Content type: ${contentType}. Subject: ${title}. Grounded facts: ${facts}. Source URL: ${sourceUrl || "none"}. Produce exactly three clearly labelled sections: YOUTUBE (search-friendly video title and description), FACEBOOK (engaging post), TIKTOK (short hook, caption and relevant hashtags). Do not invent cast, release dates, availability, plot details or claim external news is confirmed. For external reports, attribute claims to the linked report. Do not imply that MaseNet owns or streams an external title. Plain text, max 1,800 characters.`;
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.6, maxOutputTokens: 650 } }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return fallback;
    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const result = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\\n").trim();
    return result ? result.slice(0, 3500) : fallback;
  } catch { return fallback; }
}

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const expected = String(env.TELEGRAM_PROMO_CRON_SECRET || "");
  if (!expected || request.headers.get("authorization") !== "Bearer " + expected) return json({ ok: false, error: "Unauthorized" }, 401);
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Telegram or D1 binding unavailable" }, 503);

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_promo_history (
    title_name TEXT PRIMARY KEY,
    last_sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();

  const [catalogueResult, historyResult, recentCountResult] = await Promise.all([
    env.DB.prepare("SELECT name,kind,year,description,poster_url,metadata_json FROM titles ORDER BY created_at DESC LIMIT 60").all<PromoTitle>(),
    env.DB.prepare("SELECT title_name FROM telegram_promo_history WHERE last_sent_at >= datetime('now','-7 days')").all<{ title_name: string }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM telegram_promo_history WHERE last_sent_at >= datetime('now','-1 day')").first<{ count: number }>()
  ]);
  const recentlySent = new Set((historyResult.results || []).map(row => row.title_name.toLowerCase()));
  const catalogue = (catalogueResult.results || []).map(row => {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>; } catch {}
    return {
      row,
      description: String(row.description || metadata.description || "").trim(),
      poster: String(row.poster_url || metadata.posterUrl || "").trim(),
      year: String(row.year || metadata.year || "").trim()
    };
  }).filter(item => item.poster.startsWith("https://") && item.description.length > 0);
  const news = (await fetchEntertainmentNews()).filter(item => !recentlySent.has(item.key.toLowerCase()));
  const sentLast24h = Number(recentCountResult?.count || 0);

  // The cron checks every 30 minutes. It only publishes fresh, unposted items; it never repeats
  // the same story just to fill a slot. Alternate catalogue discovery and external entertainment news.
  const preferNews = sentLast24h % 2 === 1;
  const selectedNews = preferNews ? news[0] : undefined;
  const selectedCatalogue = preferNews ? undefined : catalogue.find(item => !recentlySent.has(item.row.name.toLowerCase()));
  const chosenNews = selectedNews || news[0];
  const chosenCatalogue = selectedCatalogue || catalogue.find(item => !recentlySent.has(item.row.name.toLowerCase()));

  if (!chosenNews && !chosenCatalogue) {
    return json({ ok: true, skipped: "no_fresh_items", sentLast24h, catalogueCandidates: catalogue.length, newsCandidates: news.length });
  }

  const targets = new Set<string>(["@MaseMediaTv"]);
  const subs = await env.DB.prepare("SELECT chat_id FROM telegram_subscribers WHERE active=1 AND chat_type IN ('private','channel','supergroup')").all<{ chat_id: string }>();
  for (const row of subs.results || []) if (row.chat_id) targets.add(String(row.chat_id));
  if (!targets.size) return json({ ok: false, skipped: "no_telegram_targets" }, 503);

  const results: Array<{ target: string; ok: boolean; error?: string }> = [];
  let historyKey = "";
  let contentType = "";
  let selectedName = "";
  if (chosenNews) {
    contentType = "external_news";
    selectedName = chosenNews.title;
    historyKey = chosenNews.key;
    let caption: string;
    try { caption = await generateNewsCaption(env, chosenNews); }
    catch (error) {
      console.error("Gemini news caption failed:", error instanceof Error ? error.message : String(error));
      caption = `📰 Entertainment update\n\n${chosenNews.title}\n\n${chosenNews.summary.slice(0, 360)}\n\nThis is an external report. Open the source for full details.`;
    }
    const replyMarkup = { inline_keyboard: [[{ text: "📰 Read source", url: chosenNews.link }], [{ text: "🎬 Explore MaseNet", url: MINI_APP_URL }]] };
    for (const target of targets) {
      try {
        const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: target, text: caption.slice(0, 3800), reply_markup: replyMarkup }),
          signal: AbortSignal.timeout(10000)
        });
        if (response.ok) results.push({ target, ok: true });
        else results.push({ target, ok: false, error: (await response.text()).slice(0, 220) });
      } catch (error) { results.push({ target, ok: false, error: error instanceof Error ? error.message : String(error) }); }
    }
  } else if (chosenCatalogue) {
    contentType = "catalogue";
    selectedName = chosenCatalogue.row.name;
    historyKey = chosenCatalogue.row.name;
    const kind = /movie/i.test(chosenCatalogue.row.kind) ? "movie" : "drama";
    let caption: string;
    try { caption = await generateCatalogueCaption(env, selectedName, chosenCatalogue.description, kind, chosenCatalogue.year); }
    catch (error) {
      console.error("Gemini catalogue caption failed:", error instanceof Error ? error.message : String(error));
      caption = `🎬 Discover ${selectedName}${chosenCatalogue.year ? ` (${chosenCatalogue.year})` : ""} on MaseNet!\n\n${chosenCatalogue.description.slice(0, 430)}\n\nTap below to explore and watch.`;
    }
    const replyMarkup = { inline_keyboard: [[{ text: "▶ Watch on MaseNet", url: MINI_APP_URL }]] };
    for (const target of targets) {
      try {
        const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendPhoto", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: target, photo: chosenCatalogue.poster, caption: caption.slice(0, 1000), reply_markup: replyMarkup }),
          signal: AbortSignal.timeout(10000)
        });
        if (response.ok) results.push({ target, ok: true });
        else results.push({ target, ok: false, error: (await response.text()).slice(0, 220) });
      } catch (error) { results.push({ target, ok: false, error: error instanceof Error ? error.message : String(error) }); }
    }
  }

  const delivered = results.filter(item => item.ok).length;
  if (delivered > 0 && historyKey) {
    await env.DB.prepare("INSERT INTO telegram_promo_history (title_name,last_sent_at) VALUES (?,datetime('now')) ON CONFLICT(title_name) DO UPDATE SET last_sent_at=datetime('now')").bind(historyKey).run();
  }
  let engagementPollSent = false;
  if (delivered > 0) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_promo_engagement_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      question TEXT NOT NULL
    )`).run();
    const recentPoll = await env.DB.prepare("SELECT id FROM telegram_promo_engagement_history WHERE sent_at >= datetime('now','-12 hours') LIMIT 1").first<{ id: number }>();
    if (!recentPoll) {
      const pollTemplates = [
        { question: "Which drama genre should MaseNet recommend more often?", options: ["Romance ❤️", "Action & thriller 🔥", "Historical & costume 🏯", "Mystery & suspense 🕵️"] },
        { question: "What matters most when you choose a movie or drama?", options: ["A gripping story 📖", "Strong acting 🎭", "Action & visuals 🎬", "A satisfying ending ✨"] },
        { question: "What should our next movie spotlight focus on?", options: ["New releases 🆕", "Hidden gems 💎", "Chinese dramas 🇨🇳", "Movies from around the world 🌍"] }
      ];
      const pollIndex = Math.floor(Date.now() / (12 * 60 * 60 * 1000)) % pollTemplates.length;
      const poll = pollTemplates[pollIndex];
      let pollDelivered = 0;
      for (const target of targets) {
        try {
          const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendPoll", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: target, question: poll.question, options: poll.options, is_anonymous: true, allows_multiple_answers: false }),
            signal: AbortSignal.timeout(10000)
          });
          if (response.ok) pollDelivered++;
          else console.error("Engagement poll delivery failed:", target, response.status, (await response.text()).slice(0, 180));
        } catch (error) {
          console.error("Engagement poll delivery failed:", target, error instanceof Error ? error.message : String(error));
        }
      }
      if (pollDelivered > 0) {
        await env.DB.prepare("INSERT INTO telegram_promo_engagement_history (question,sent_at) VALUES (?,datetime('now'))").bind(poll.question).run();
        engagementPollSent = true;
      }
    }
  }

  let socialDraftSent = false;
  if (delivered > 0 && env.ADMIN_TELEGRAM_CHAT_ID) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_social_draft_history (
      content_key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
    const dailyDrafts = await env.DB.prepare("SELECT COUNT(*) AS count FROM telegram_social_draft_history WHERE created_at >= datetime('now','-1 day')").first<{ count: number }>();
    const draftKey = historyKey + ":" + new Date().toISOString().slice(0, 10);
    const alreadySent = await env.DB.prepare("SELECT content_key FROM telegram_social_draft_history WHERE content_key=?").bind(draftKey).first<{ content_key: string }>();
    if (!alreadySent && Number(dailyDrafts?.count || 0) < 3) {
      const facts = chosenNews
        ? chosenNews.title + ". " + chosenNews.summary
        : selectedName + ". " + chosenCatalogue!.description;
      const sourceUrl = chosenNews?.link || "";
      const pack = await generateSocialPack(env, selectedName, facts, contentType, sourceUrl);
      try {
        const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: env.ADMIN_TELEGRAM_CHAT_ID, text: pack.slice(0, 3900), disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10000)
        });
        if (response.ok) {
          await env.DB.prepare("INSERT OR IGNORE INTO telegram_social_draft_history (content_key,created_at) VALUES (?,datetime('now'))").bind(draftKey).run();
          socialDraftSent = true;
        } else {
          console.error("Admin social draft delivery failed:", response.status, (await response.text()).slice(0, 220));
        }
      } catch (error) {
        console.error("Admin social draft delivery failed:", error instanceof Error ? error.message : String(error));
      }
    }
  }

  return json({
    ok: delivered > 0, type: contentType, title: selectedName, delivered, socialDraftSent, engagementPollSent,
    failed: results.length - delivered, targets: targets.size, sentLast24h,
    geminiConfigured: !!env.GEMINI_API_KEY,
    newsFeedItems: news.length, catalogueCandidates: catalogue.length,
    results
  });
};
