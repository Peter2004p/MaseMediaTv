interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_PROMO_CRON_SECRET?: string;
  GEMINI_API_KEY?: string;
  TELEGRAM_WEBAPP_URL?: string;
  TELEGRAM_MINI_APP_URL?: string;
}

type PromoTitle = { name: string; kind: string; year: number | null; description: string; poster_url: string; metadata_json: string; created_at?: string };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function generateCaption(env: Env, title: string, description: string, kind: string, year: string) {
  const fallback = `🎬 Now showing on MaseNet: ${title}${year ? ` (${year})` : ""}\n\n${description.slice(0, 430)}\n\nTap the button below to open MaseNet and start watching.`;
  if (!env.GEMINI_API_KEY) return fallback;
  const prompt = `Write a persuasive but truthful Telegram promo caption for this MaseNet ${kind}. Title: ${title}. Year: ${year || "not listed"}. Official synopsis: ${description || "No synopsis provided."}. Use only facts in the synopsis; do not invent actors, awards, episode counts, availability, or plot details. Make it engaging, concise, and inviting. Include the exact title, a short hook, and a clear invitation to tap the Telegram Mini App button below. Do not include any website address, URL, domain, or link. Return plain text only, max 650 characters. Do not include markdown or HTML.`;
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 220 } })
  });
  if (!response.ok) throw new Error("Gemini promo generation failed: HTTP " + response.status);
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n").trim();
  if (!text) throw new Error("Gemini returned an empty promo caption.");
  return text.replace(/https?:\/\/[^\s<>]+/gi, "").replace(/\b[a-z0-9.-]+\.(?:pages\.dev|floot\.app)\b[^\s<>]*/gi, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 700);
}

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const expected = String(env.TELEGRAM_PROMO_CRON_SECRET || "");
  const auth = request.headers.get("authorization") || "";
  if (!expected || auth !== "Bearer " + expected) return json({ ok: false, error: "Unauthorized" }, 401);
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Telegram or D1 binding unavailable" }, 503);

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_promo_history (
    title_name TEXT PRIMARY KEY,
    last_sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();

  const query = await env.DB.prepare(
    "SELECT name,kind,year,description,poster_url,metadata_json,created_at FROM titles ORDER BY created_at DESC LIMIT 60"
  ).all<PromoTitle>();
  const titles = query.results || [];
  if (!titles.length) return json({ ok: true, skipped: "catalogue_empty" });

  const history = await env.DB.prepare("SELECT title_name FROM telegram_promo_history WHERE last_sent_at >= datetime('now','-7 days')").all<{ title_name: string }>();
  const recentlySent = new Set((history.results || []).map(row => row.title_name.toLocaleLowerCase()));
  const candidates = titles.map(row => {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>; } catch {}
    return {
      row,
      description: String(row.description || metadata.description || "").trim(),
      poster: String(row.poster_url || metadata.posterUrl || "").trim(),
      year: String(row.year || metadata.year || "").trim()
    };
  }).filter(item => item.poster.startsWith("https://") && item.description.length > 0);
  if (!candidates.length) return json({ ok: false, skipped: "no_titles_with_poster_and_description" }, 422);
  const selectedItem = candidates.find(item => !recentlySent.has(item.row.name.toLocaleLowerCase())) || candidates[0];
  const selected = selectedItem.row;
  const description = selectedItem.description;
  const poster = selectedItem.poster;
  const kind = /movie/i.test(selected.kind) ? "movie" : "drama";
  const year = selectedItem.year;
  let caption: string;
  try {
    caption = await generateCaption(env, selected.name, description, kind, year);
  } catch (error) {
    console.error("Gemini promotional caption failed:", error instanceof Error ? error.message : String(error));
    caption = `🎬 Discover ${selected.name}${year ? ` (${year})` : ""} on MaseNet!\n\n${description.slice(0, 430)}\n\nTap the button below to explore and watch on MaseNet.`;
  }

  const miniAppLaunchUrl = "https://t.me/MaseTv_Bot?startapp=home";
  // Telegram Mini App deep link works in channel notifications too; never expose the Pages origin.\n  const replyMarkup = { inline_keyboard: [[{ text: "▶ Watch on MaseNet", url: miniAppLaunchUrl }]] };\n  const targets = new Set<string>();
  targets.add("@MaseMediaTv");
  const subs = await env.DB.prepare("SELECT chat_id FROM telegram_subscribers WHERE active=1 AND chat_type='private'").all<{ chat_id: string }>();
  for (const row of subs.results || []) if (row.chat_id) targets.add(String(row.chat_id));

  const results: Array<{ target: string; ok: boolean; error?: string }> = [];
  for (const target of targets) {
    const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendPhoto", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: target, photo: poster, caption: caption.slice(0, 1000), reply_markup: replyMarkup })
    });
    if (response.ok) results.push({ target, ok: true });
    else {
      const errorText = await response.text();
      results.push({ target, ok: false, error: errorText.slice(0, 220) });
      console.error("MaseNet promo delivery failed:", target, response.status, errorText.slice(0, 300));
    }
  }

  const successes = results.filter(item => item.ok).length;
  if (successes > 0) {
    await env.DB.prepare("INSERT INTO telegram_promo_history (title_name,last_sent_at) VALUES (?,datetime('now')) ON CONFLICT(title_name) DO UPDATE SET last_sent_at=datetime('now')").bind(selected.name).run();
  }
  return json({ ok: successes > 0, title: selected.name, geminiConfigured: !!env.GEMINI_API_KEY, delivered: successes, failed: results.length - successes, results });
};
