import { json } from "../../auth/_shared";

interface Env { DB: D1Database; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_WEBHOOK_SECRET?: string; }
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

  const query = incoming.replace(/^\/start(?:\s+\S+)?/i, "").replace(/^\/search\s*/i, "").trim();
  let reply = "Welcome to MaseTv! Send a movie, drama, or episode name to search the library.";
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
      for (const ep of (Array.isArray(item.episodes) ? item.episodes : [])) {
        const epName = ep.title || ep.name || "";
        const season = ep.season == null ? "" : "S" + String(ep.season).replace(/^S/i, "");
        const episodeNo = ep.episode == null ? "" : "E" + String(ep.episode).replace(/^E/i, "");
        const label = [season, episodeNo].filter(Boolean).join("");
        const searchable = normalize([name, epName, label, "season " + ep.season, "episode " + ep.episode].join(" "));
        if (searchable.includes(needle) || (normalize(name).includes(needle) && (needle.includes(" episode ") || needle.includes(" ep ")))) {
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
    body: JSON.stringify({ chat_id: chatId, text: reply.slice(0, 3900), disable_web_page_preview: true })
  });
  if (!send.ok) return json({ ok: false, error: "Telegram could not deliver the search reply." }, 502);
  return json({ ok: true });
};
