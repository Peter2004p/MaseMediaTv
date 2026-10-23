import { json } from "../../auth/_shared";

interface Env { DB: D1Database; AI?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> }; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_WEBHOOK_SECRET?: string; TELEGRAM_MINI_APP_URL?: string; TELEGRAM_WEBAPP_URL?: string; }
type Episode = { title?: string; season?: number | string; episode?: number | string; name?: string };
type CatalogItem = { id?: string; name?: string; type?: string; kind?: string; year?: number | string; description?: string; episodes?: Episode[] };

const normalize = (value: unknown) => String(value ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Bot token not configured" }, 503);
  if (!env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false, error: "Webhook secret is not configured" }, 503);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false }, 401);

  const update = await request.json().catch(() => ({})) as {
    message?: { chat?: { id?: number | string }; text?: string };
    edited_message?: { chat?: { id?: number | string }; text?: string };
  };
  const msg = update.message || update.edited_message;
  const chatId = msg?.chat?.id;
  const incoming = String(msg?.text || "").trim();
  if (!chatId || !incoming) return json({ ok: true });

  const command = incoming.split(/\s+/, 1)[0].toLowerCase().replace(/@[^@]+$/, "");
  const commandText = incoming.includes(" ") ? incoming.slice(incoming.indexOf(" ") + 1).trim() : "";
  const miniAppUrl = (env.TELEGRAM_MINI_APP_URL || env.TELEGRAM_WEBAPP_URL || "").trim();
  const replyMarkup = miniAppUrl.startsWith("https://") ? { inline_keyboard: [[{ text: "Open MaseNet", web_app: { url: miniAppUrl } }]] } : undefined;

  if (["/help", "/commands"].includes(command)) {
    const sent = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: "MaseNet Assistant\n\nSend a movie/drama/episode name to search.\n/search title — search the catalog.\n/ai question — ask the AI assistant.\n/start — welcome message.", ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }) });
    return sent.ok ? json({ ok: true }) : json({ ok: false, error: "Telegram could not deliver the help reply." }, 502);
  }

  if (command === "/ai" || command === "/ask") {
    const prompt = commandText || "Introduce yourself as the MaseNet Telegram AI assistant.";
    let answer = "";
    if (env.AI) {
      try {
        const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { messages: [
          { role: "system", content: "You are MaseNet's friendly Telegram AI assistant. Help with movie/drama discovery, episode search instructions, and general questions. Never claim catalog availability unless confirmed by search. Never reveal secrets or private admin data. Be concise and safe." },
          { role: "user", content: prompt.slice(0, 3000) }
        ], max_tokens: 700 });
        if (result && typeof result === "object") {
          const data = result as { response?: string; choices?: Array<{ message?: { content?: string } }> };
          answer = String(data.response || data.choices?.[0]?.message?.content || "").trim();
        }
      } catch { /* Graceful fallback below. */ }
    }
    if (!answer) answer = "I'm MaseNet's assistant. Send a title to search movies, dramas, and episodes, or use /search title. The AI service is temporarily unavailable; catalog search still works.";
    const sent = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: answer.slice(0, 3900), disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }) });
    return sent.ok ? json({ ok: true }) : json({ ok: false, error: "Telegram could not deliver the AI reply." }, 502);
  }

  const query = incoming.replace(/^\/start(?:\s+\S+)?/i, "").replace(/^\/search\s*/i, "").trim();
  let reply = "Welcome to MaseNet! 🎬\nSend a movie, drama, or episode name to search the library.\nNeed help? Use /help. Ask a question with /ai your question.";
  if (query) {
    const needle = normalize(query).slice(0, 100);
    const sql = await env.DB.prepare(
      "SELECT name,kind,year,description,metadata_json FROM titles ORDER BY created_at DESC LIMIT 500"
    ).all<{ name: string; kind: string; year: number | null; description: string | null; metadata_json: string }>();
    const titleMatches: string[] = [];
    const episodeMatches: string[] = [];
    for (const row of sql.results || []) {
      const item: CatalogItem = { name: row.name, kind: row.kind, year: row.year ?? undefined, description: row.description ?? undefined };
      try { Object.assign(item, JSON.parse(row.metadata_json)); } catch { /* Keep database columns as fallback. */ }
      const name = item.name || row.name || "Untitled";
      if (normalize(name).includes(needle) || normalize(item.description || row.description).includes(needle)) {
        titleMatches.push("• " + name + (item.year ? " (" + item.year + ")" : "") + " — " + (item.type || item.kind || row.kind || "Title"));
      }
      const queryEpisode = needle.match(/\b(?:episode|ep|e)\s*(\d+)\b/)?.[1];
      const querySeason = needle.match(/\b(?:season|s)\s*(\d+)\b/)?.[1];
      const titleQuery = needle.replace(/\b(?:season|episode|ep|s|e)\s*\d+\b/g, " ").replace(/\b\d+\b/g, " ").trim();
      for (const ep of (Array.isArray(item.episodes) ? item.episodes : [])) {
        const epName = ep.title || ep.name || "";
        const seasonNumber = String(ep.season ?? "").match(/\d+/)?.[0] || "";
        const episodeNumber = String(ep.episode ?? "").match(/\d+/)?.[0] || "";
        const label = (seasonNumber ? "S" + seasonNumber : "") + (episodeNumber ? "E" + episodeNumber : "");
        const searchable = normalize([name, epName, label, "season " + seasonNumber, "episode " + episodeNumber].join(" "));
        const titleAndNumberMatch = !!titleQuery && normalize(name).includes(titleQuery)
          && (!queryEpisode || queryEpisode === episodeNumber)
          && (!querySeason || querySeason === seasonNumber);
        if (searchable.includes(needle) || normalize(epName).includes(needle) || titleAndNumberMatch) {
          episodeMatches.push("• " + name + (item.year ? " (" + item.year + ")" : "") + (label ? " — " + label : "") + (epName ? " " + epName : ""));
        }
      }
      if (titleMatches.length >= 5 && episodeMatches.length >= 5) break;
    }
    const combined = [...new Set([...episodeMatches, ...titleMatches])].slice(0, 5);
    reply = combined.length
      ? "MaseTv search results for “" + query.slice(0, 80) + "”:\n" + combined.join("\n")
      : "I couldn't find that movie, drama, or episode in the MaseTv library yet. Try a shorter title or check again later.";
  }

  const send = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: reply.slice(0, 3900),
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    })
  });
  if (!send.ok) return json({ ok: false, error: "Telegram could not deliver the search reply." }, 502);
  return json({ ok: true });
};
