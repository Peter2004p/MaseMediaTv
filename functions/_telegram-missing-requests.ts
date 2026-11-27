import type { Env } from "./api/auth/_shared";

const normalize = (value: unknown) => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[’']/g, "").replace(/[^\\p{L}\\p{N}]+/gu, " ").trim();

export async function notifyMatchingMissingTitleRequests(env: Env, titleName: string): Promise<{ matched: number; notified: number; failed: number }> {
  const result = { matched: 0, notified: 0, failed: 0 };
  if (!titleName.trim()) return result;
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_missing_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, chat_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), requester_chat_id TEXT,
      requester_name TEXT, requester_username TEXT, status TEXT NOT NULL DEFAULT 'pending',
      feedback TEXT, admin_notified_at TEXT
    )`).run();
    for (const [column, definition] of [["requester_chat_id","TEXT"],["requester_name","TEXT"],["requester_username","TEXT"],["status","TEXT NOT NULL DEFAULT 'pending'"],["feedback","TEXT"],["admin_notified_at","TEXT"]] as const) {
      try { await env.DB.prepare("ALTER TABLE telegram_missing_searches ADD COLUMN " + column + " " + definition).run(); } catch {}
    }
    const pending = await env.DB.prepare("SELECT id,query,requester_chat_id FROM telegram_missing_searches WHERE status='pending' AND requester_chat_id IS NOT NULL ORDER BY id ASC LIMIT 100").all<{id:number;query:string;requester_chat_id:string}>();
    const matches = (pending.results || []).filter(row => normalize(row.query) === normalize(titleName));
    result.matched = matches.length;
    const token = (env as Env & { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN;
    if (!token) { result.failed = matches.length; return result; }
    for (const row of matches) {
      try {
        const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: row.requester_chat_id, text: "🎉 Good news! “" + titleName.slice(0,180) + "” has now been added to the MaseNet library. Open MaseNet to check its available episodes and playback options.", disable_web_page_preview: true })
        });
        const data = await response.json().catch(() => ({})) as {ok?:boolean};
        if (!response.ok || !data.ok) { result.failed++; continue; }
        await env.DB.prepare("UPDATE telegram_missing_searches SET status='available',feedback=?,updated_at=COALESCE(updated_at,datetime('now')) WHERE id=? AND status='pending'".replace(",updated_at=COALESCE(updated_at,datetime('now'))","")).bind("Automatically notified after the exact title was published in the MaseNet library.", row.id).run();
        result.notified++;
      } catch { result.failed++; }
    }
  } catch (error) {
    console.error("MaseNet missing-title auto-notification failed:", error instanceof Error ? error.message : String(error));
    result.failed += result.matched || 1;
  }
  return result;
}
