import { json } from "./auth/_shared";
interface Env { DB: D1Database; ADMIN_EMAIL?: string; }
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const body = await request.json().catch(() => ({})) as { message?: unknown; adminMode?: boolean; viewerName?: string };
  const message = String(body.message || "").trim().slice(0, 2000);
  if (!message) return json({ text: "Tell me what you would like help with." });
  const rows = await env.DB.prepare("SELECT name,kind,year,description FROM titles ORDER BY created_at DESC LIMIT 100").all<{name:string;kind:string;year:number|null;description:string}>();
  const titles = rows.results || [];
  const q = message.toLowerCase();
  if (/recommend|available|library|drama|movie|search|find/.test(q)) {
    const matches = titles.filter(t => (t.name + " " + t.kind + " " + t.description).toLowerCase().split(/[^a-z0-9]+/).some(w => w.length > 2 && q.includes(w)));
    if (!titles.length) return json({ text: "The MaseNet library is empty on the Cloudflare migration database right now. Your existing AppDeploy site has not been changed." });
    if (matches.length) return json({ text: "Here are matching titles in the MaseNet library:\n" + matches.slice(0,5).map(t => "• " + t.name + (t.year ? " ("+t.year+")" : "") + " — " + t.kind).join("\n") });
    return json({ text: "I couldn't find an exact match in the Cloudflare MaseNet library yet. Try the title's shorter name or check back later." });
  }
  return json({ text: "I'm the MaseNet assistant on the Cloudflare migration preview. I can help search the titles currently stored in this Cloudflare library. Full AI replies and Telegram-connected actions are not enabled until their service credentials and webhook are configured." });
};