interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  ADMIN_TELEGRAM_CHAT_ID?: string;
  TELEGRAM_PROMO_CRON_SECRET?: string;
  PROMO_CRON_SECRET?: string;
  YOUTUBE_CHANNEL_ID?: string;
  FACEBOOK_PAGE_URL?: string;
  TIKTOK_PROFILE_URL?: string;
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
    // Upcoming Chinese dramas and casting/premiere announcements, including titles not in MaseNet.
    "https://news.google.com/rss/search?q=upcoming+Chinese+drama+2026+OR+2027+release+date&hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/search?q=Chinese+drama+casting+premiere+release+announcement&hl=en-US&gl=US&ceid=US:en",
    // Wider Asian and global movie/TV coverage, viral titles and audience recommendations.
    "https://news.google.com/rss/search?q=trending+viral+movie+drama+series+popular+this+week&hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/search?q=best+new+movies+to+watch+streaming+2026&hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/search?q=trending+Chinese+drama+popular+most+watched&hl=en-US&gl=US&ceid=US:en",
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
    const blocks = xml.match(new RegExp("<item(?:\\s[^>]*)?>[\\s\\S]*?</item>", "gi")) || [];
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
  const fallback = description
    ? `🎬 Now showing on MaseNet: ${title}${year ? ` (${year})` : ""}\n\n${description.slice(0, 430)}\n\nTap below to open MaseNet and start watching.`
    : `🎬 MaseNet watch suggestion\n\nSpotlight: ${title}${year ? ` (${year})` : ""}.\n\nOpen MaseNet to explore this title and see its available details.\n\nA fresh pick from the MaseNet catalogue.`;
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
  const parsedDate = item.published ? new Date(item.published) : null;
  const date = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString().slice(0, 10) : "";
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
    const result = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n").trim();
    return result ? result.slice(0, 3500) : fallback;
  } catch { return fallback; }
}

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  // Accept either configured name so the scheduled Worker and Pages function
  // can share the same bearer secret without depending on two differently named bindings.
  const expectedSecrets = [env.PROMO_CRON_SECRET, env.TELEGRAM_PROMO_CRON_SECRET]
    .map(value => String(value || "").trim()).filter(Boolean);
  const supplied = String(request.headers.get("authorization") || "").trim();
  if (!expectedSecrets.length || !expectedSecrets.some(secret => supplied === "Bearer " + secret)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Telegram or D1 binding unavailable" }, 503);

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_promo_history (
    title_name TEXT PRIMARY KEY,
    last_sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();

  const requestUrl = new URL(request.url);
  const campaignSlot = (requestUrl.searchParams.get("slot") || String(Math.floor(Date.now() / 1800000))).slice(0, 80);
  const batchIndex = Math.max(0, Math.min(20, Number.parseInt(requestUrl.searchParams.get("batch") || "0", 10) || 0));
  const batchSize = Math.max(5, Math.min(20, Number.parseInt(requestUrl.searchParams.get("batchSize") || "15", 10) || 15));
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_promo_campaigns (
    slot TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();

  type Campaign = { contentType: string; selectedName: string; historyKey: string; caption: string; poster: string; sourceUrl: string; facts: string };
  const savedCampaign = await env.DB.prepare("SELECT payload_json FROM telegram_promo_campaigns WHERE slot=?").bind(campaignSlot).first<{ payload_json: string }>();
  let campaign: Campaign | null = null;
  if (savedCampaign?.payload_json) {
    try { campaign = JSON.parse(savedCampaign.payload_json) as Campaign; } catch { campaign = null; }
  }

  let sentLast24h = 0;
  let catalogueCandidates = 0;
  let newsCandidates = 0;
  let catalogueRecentlySpotlighted = 0;
  if (!campaign) {
    const [catalogueResult, historyResult, catalogueCooldownResult, recentCountResult] = await Promise.all([
      env.DB.prepare("SELECT name,kind,year,description,poster_url,metadata_json FROM titles ORDER BY created_at DESC LIMIT 60").all<PromoTitle>(),
      env.DB.prepare("SELECT title_name FROM telegram_promo_history WHERE last_sent_at >= datetime('now','-7 days')").all<{ title_name: string }>(),
      env.DB.prepare("SELECT title_name FROM telegram_promo_history WHERE last_sent_at >= datetime('now','-30 minutes')").all<{ title_name: string }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM telegram_promo_history WHERE last_sent_at >= datetime('now','-1 day')").first<{ count: number }>()
    ]);
    const recentlySent = new Set((historyResult.results || []).map(row => row.title_name.toLowerCase()));
    const recentlySpotlighted = new Set((catalogueCooldownResult.results || []).map(row => row.title_name.toLowerCase()));
    catalogueRecentlySpotlighted = recentlySpotlighted.size;
    const catalogue = (catalogueResult.results || []).map(row => {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>; } catch {}
      return {
        row,
        description: String(row.description || metadata.description || "").trim(),
        poster: String(row.poster_url || metadata.posterUrl || "").trim(),
        year: String(row.year || metadata.year || "").trim()
      };
    }).filter(item => !!String(item.row.name || "").trim());
    const news = (await fetchEntertainmentNews()).filter(item => !recentlySent.has(item.key.toLowerCase()));
    sentLast24h = Number(recentCountResult?.count || 0);
    catalogueCandidates = catalogue.length;
    newsCandidates = news.length;
    const preferNews = sentLast24h % 2 === 1;
    const chosenNews = (preferNews ? news[0] : undefined) || news[0];
    const chosenCatalogue = (preferNews ? undefined : catalogue.find(item => !recentlySpotlighted.has(item.row.name.toLowerCase()))) || catalogue.find(item => !recentlySpotlighted.has(item.row.name.toLowerCase()));
    if (!chosenNews && !chosenCatalogue) {
      return json({ ok: true, skipped: "no_fresh_items", sentLast24h, catalogueCandidates, catalogueRecentlySpotlighted, newsCandidates, newsFeedItems: news.length, geminiConfigured: !!env.GEMINI_API_KEY });
    }
    if (chosenNews) {
      let caption: string;
      try { caption = await generateNewsCaption(env, chosenNews); }
      catch (error) {
        console.error("Gemini news caption failed:", error instanceof Error ? error.message : String(error));
        caption = `📰 Entertainment update\\n\\n${chosenNews.title}\\n\\n${chosenNews.summary.slice(0, 360)}\\n\\nThis is an external report. Open the source for full details.`;
      }
      campaign = {
        contentType: "external_news", selectedName: chosenNews.title, historyKey: chosenNews.key,
        caption, poster: "", sourceUrl: chosenNews.link, facts: chosenNews.title + ". " + chosenNews.summary
      };
    } else if (chosenCatalogue) {
      const selectedName = chosenCatalogue.row.name;
      const kind = /movie/i.test(chosenCatalogue.row.kind) ? "movie" : "drama";
      let caption: string;
      try { caption = await generateCatalogueCaption(env, selectedName, chosenCatalogue.description, kind, chosenCatalogue.year); }
      catch (error) {
        console.error("Gemini catalogue caption failed:", error instanceof Error ? error.message : String(error));
        caption = `🎬 Discover ${selectedName}${chosenCatalogue.year ? ` (${chosenCatalogue.year})` : ""} on MaseNet!\\n\\n${chosenCatalogue.description.slice(0, 430)}\\n\\nTap below to explore and watch.`;
      }
      campaign = {
        contentType: "catalogue", selectedName, historyKey: selectedName,
        caption, poster: chosenCatalogue.poster, sourceUrl: "",
        facts: selectedName + ". " + chosenCatalogue.description
      };
    }
    if (!campaign) return json({ ok: false, error: "Could not prepare a promotion campaign" }, 500);
    await env.DB.prepare("INSERT OR IGNORE INTO telegram_promo_campaigns (slot,payload_json) VALUES (?,?)")
      .bind(campaignSlot, JSON.stringify(campaign)).run();
  }

  const targets = new Set<string>(["@MaseMediaTv"]);
  const subs = await env.DB.prepare("SELECT chat_id,chat_type FROM telegram_subscribers WHERE active=1 AND chat_type IN ('private','channel','supergroup')").all<{ chat_id: string; chat_type: string }>();
  const channelTargets = new Set<string>(["@MaseMediaTv"]);
  for (const row of subs.results || []) {
    if (!row.chat_id) continue;
    targets.add(String(row.chat_id));
    if (row.chat_type === "channel" || row.chat_type === "supergroup") channelTargets.add(String(row.chat_id));
  }
  const targetList = Array.from(targets).sort();
  if (!targetList.length) return json({ ok: false, skipped: "no_telegram_targets" }, 503);
  const batchCount = Math.max(1, Math.ceil(targetList.length / batchSize));
  if (batchIndex >= batchCount) return json({ ok: true, skipped: "batch_complete", campaignSlot, batchIndex, batchCount });
  const batchTargets = targetList.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);

  const results: Array<{ target: string; ok: boolean; error?: string }> = [];
  const replyMarkup = campaign.contentType === "external_news"
    ? { inline_keyboard: [[{ text: "📰 Read source", url: campaign.sourceUrl }], [{ text: "🎬 Explore MaseNet", url: MINI_APP_URL }]] }
    : { inline_keyboard: [[{ text: "▶ Watch on MaseNet", url: MINI_APP_URL }]] };
  for (const target of batchTargets) {
    try {
      const hasPoster = campaign.contentType === "catalogue" && /^https:\\/\\//i.test(campaign.poster);
      const method = hasPoster ? "sendPhoto" : "sendMessage";
      const payload = hasPoster
        ? { chat_id: target, photo: campaign.poster, caption: campaign.caption.slice(0, 1000), reply_markup: replyMarkup }
        : { chat_id: target, text: campaign.caption.slice(0, 3800), reply_markup: replyMarkup, disable_web_page_preview: campaign.contentType === "catalogue" };
      const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
      });
      if (response.ok) results.push({ target, ok: true });
      else results.push({ target, ok: false, error: (await response.text()).slice(0, 220) });
    } catch (error) {
      results.push({ target, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const delivered = results.filter(item => item.ok).length;
  // Classify delivery failures from Telegram's JSON body or transport error.
  // Permanently unreachable chats are disabled so every scheduled broadcast does not
  // keep retrying dead private chats or channels.
  const classifyFailure = (raw: string) => {
    let code = 0;
    let description = String(raw || "Unknown Telegram delivery error").slice(0, 500);
    try {
      const parsed = JSON.parse(description) as { error_code?: number; description?: string };
      code = Number(parsed.error_code || 0);
      description = String(parsed.description || description);
    } catch {}
    const message = description.toLowerCase();
    const category = /bot was blocked by the user|blocked by the user|user is deactivated|chat not found|peer_id_invalid/.test(message)
      ? "blocked_or_missing_chat"
      : /not enough rights|not a member|kicked|bot was kicked|forbidden/.test(message)
        ? "bot_permission"
        : code === 429 || /too many requests/.test(message)
          ? "rate_limited"
          : code >= 500 || /upstream|internal server|temporarily unavailable/.test(message)
            ? "telegram_server_error"
            : /abort|timeout|timed out|network|fetch failed|connection/.test(message)
              ? "network_or_timeout"
              : "other";
    return { category, code, description: description.replace(/\b\d{7,15}\b/g, "[chat]").slice(0, 180) };
  };
  const failureItems = results.filter(item => !item.ok).map(item => ({ ...item, ...classifyFailure(item.error || "") }));
  const failureReasons = failureItems.reduce((counts, item) => {
    counts[item.category] = (counts[item.category] || 0) + 1;
    return counts;
  }, {} as Record<string, number>);

  // Disable only permanent Telegram delivery failures. Transient network, rate-limit,
  // and server failures remain active and are retried on the next scheduled run.
  const permanentlyUnavailable = failureItems.filter(item =>
    item.category === "blocked_or_missing_chat" || item.category === "bot_permission"
  );
  if (permanentlyUnavailable.length) {
    await Promise.all(permanentlyUnavailable.map(item =>
      env.DB.prepare("UPDATE telegram_subscribers SET active=0,updated_at=datetime('now') WHERE chat_id=?")
        .bind(item.target).run().catch(error => {
          console.error("Could not deactivate unreachable Telegram subscriber:", error instanceof Error ? error.message : String(error));
        })
    ));
  }
  const failureSamples = failureItems.slice(0, 8).map(item => ({
    category: item.category,
    httpCode: item.code || undefined,
    reason: item.description
  }));

  // Persist aggregate delivery diagnostics so the next cron run can be inspected
  // without exposing subscriber IDs or manually triggering another broadcast.
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_promo_delivery_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      content_type TEXT NOT NULL,
      delivered INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      targets INTEGER NOT NULL,
      failure_category TEXT NOT NULL,
      failure_count INTEGER NOT NULL,
      failure_detail TEXT NOT NULL DEFAULT ''
    )`).run();
    try {
      await env.DB.prepare("ALTER TABLE telegram_promo_delivery_metrics ADD COLUMN failure_detail TEXT NOT NULL DEFAULT ''").run();
    } catch { /* Column already exists. */ }
    const categories = Object.entries(failureReasons);
    if (!categories.length) categories.push(["none", 0]);
    await Promise.all(categories.map(([category, count]) => {
      const sample = failureItems.find(item => item.category === category);
      return env.DB.prepare("INSERT INTO telegram_promo_delivery_metrics (content_type,delivered,failed,targets,failure_category,failure_count,failure_detail) VALUES (?,?,?,?,?,?,?)")
        .bind(contentType, delivered, results.length - delivered, targets.size, category, count, sample?.description || "").run();
    }));
  } catch (error) {
    console.error("Promo delivery metrics could not be saved:", error instanceof Error ? error.message : String(error));
  }
  if (delivered > 0 && historyKey) {
    await env.DB.prepare("INSERT INTO telegram_promo_history (title_name,last_sent_at) VALUES (?,datetime('now')) ON CONFLICT(title_name) DO UPDATE SET last_sent_at=datetime('now')").bind(historyKey).run();
  }
  let engagementPollSent = false;
  if (delivered > 0 && batchIndex === 0) {
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
      for (const target of channelTargets) {
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
  if (delivered > 0 && batchIndex === 0 && env.ADMIN_TELEGRAM_CHAT_ID) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_social_draft_history (
      content_key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
    const dailyDrafts = await env.DB.prepare("SELECT COUNT(*) AS count FROM telegram_social_draft_history WHERE created_at >= datetime('now','-1 day')").first<{ count: number }>();
    const draftKey = historyKey + ":" + new Date().toISOString().slice(0, 10);
    const alreadySent = await env.DB.prepare("SELECT content_key FROM telegram_social_draft_history WHERE content_key=?").bind(draftKey).first<{ content_key: string }>();
    if (!alreadySent && Number(dailyDrafts?.count || 0) < 3) {
      const facts = campaign.facts;
      const sourceUrl = campaign.sourceUrl;
      const pack = await generateSocialPack(env, campaign.selectedName, facts, campaign.contentType, sourceUrl);
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
    ok: true, deliveryOk: delivered > 0, type: campaign.contentType, title: campaign.selectedName, delivered, socialDraftSent, engagementPollSent,
    failed: results.length - delivered, failureReasons, failureSamples,
    disabledPermanentTargets: permanentlyUnavailable.length,
    targets: batchTargets.length, totalTargets: targetList.length, batchIndex, batchCount, batchSize, campaignSlot, sentLast24h,
    geminiConfigured: !!env.GEMINI_API_KEY,
    results: results.filter(item => item.ok).map(item => ({ ok: true })).concat(failureItems.map(item => ({ ok: false, category: item.category, reason: item.description })))
  });
};
