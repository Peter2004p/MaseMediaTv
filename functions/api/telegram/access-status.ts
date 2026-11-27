interface Env { DB: D1Database; TELEGRAM_BOT_TOKEN?: string; }
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function hmac(key: BufferSource, data: string) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)));
}
const hex = (value: Uint8Array) => [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Telegram membership verification is not configured." }, 503);
  const body = await request.json().catch(() => ({})) as { initData?: string };
  const params = new URLSearchParams(String(body.initData || ""));
  const hash = params.get("hash") || "";
  params.delete("hash");
  const authDate = Number(params.get("auth_date") || 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!hash || !Number.isSafeInteger(authDate) || authDate <= 0 || authDate > nowSeconds + 60 || nowSeconds - authDate > 86400) {
    return json({ error: "Your Telegram session expired. Close and reopen MaseNet." }, 401);
  }
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  const checkString = entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), env.TELEGRAM_BOT_TOKEN);
  const expected = hex(await hmac(secret, checkString));
  if (expected.length !== hash.length) return json({ error: "Telegram session validation failed." }, 401);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ hash.charCodeAt(i);
  if (mismatch !== 0) return json({ error: "Telegram session validation failed." }, 401);

  let user: { id?: number | string } | null = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch {}
  if (!user?.id) return json({ error: "Telegram user was not found." }, 401);
  const chatId = String(user.id);

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_access_verification (
    chat_id TEXT PRIMARY KEY,
    masemedia_ok INTEGER NOT NULL DEFAULT 0,
    moondramac_ok INTEGER NOT NULL DEFAULT 0,
    membership_checked_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  try { await env.DB.prepare("ALTER TABLE telegram_access_verification ADD COLUMN membership_checked_at TEXT").run(); } catch { /* Existing column. */ }

  const saved = await env.DB.prepare(
    "SELECT masemedia_ok,moondramac_ok,membership_checked_at FROM telegram_access_verification WHERE chat_id=?"
  ).bind(chatId).first<{ masemedia_ok: number; moondramac_ok: number; membership_checked_at: string | null }>();
  const checkedAt = saved?.membership_checked_at ? Date.parse(saved.membership_checked_at.replace(" ", "T") + "Z") : 0;
  const membershipFresh = Number.isFinite(checkedAt) && Date.now() - checkedAt < 30000;
  let membership = {
    masemedia: membershipFresh && !!saved?.masemedia_ok,
    moondramac: membershipFresh && !!saved?.moondramac_ok
  };
  const membershipCheckErrors: Partial<Record<"masemedia" | "moondramac", string>> = {};

  if (!membershipFresh) {
    let checksSucceeded = true;
    for (const [channel, key] of [["@MaseMediaTv", "masemedia"], ["@MoonDramaC", "moondramac"]] as const) {
      try {
        const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/getChatMember?chat_id=" +
          encodeURIComponent(channel) + "&user_id=" + encodeURIComponent(chatId));
        const result = await response.json().catch(() => ({})) as {
          ok?: boolean; description?: string;
          result?: { status?: string; is_member?: boolean };
        };
        if (!response.ok || !result.ok) {
          checksSucceeded = false;
          membershipCheckErrors[key] = String(result.description || "Telegram could not confirm this channel membership.");
          membership[key] = false;
          continue;
        }
        const status = String(result.result?.status || "");
        membership[key] = ["member", "administrator", "creator"].includes(status) ||
          (status === "restricted" && result.result?.is_member === true);
      } catch {
        checksSucceeded = false;
        membership[key] = false;
        membershipCheckErrors[key] = "Telegram membership check is temporarily unavailable.";
      }
    }
    if (checksSucceeded) {
      await env.DB.prepare(
        "INSERT INTO telegram_access_verification (chat_id,masemedia_ok,moondramac_ok,membership_checked_at,updated_at) VALUES (?,?,?,datetime('now'),datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET masemedia_ok=excluded.masemedia_ok,moondramac_ok=excluded.moondramac_ok,membership_checked_at=datetime('now'),updated_at=datetime('now')"
      ).bind(chatId, membership.masemedia ? 1 : 0, membership.moondramac ? 1 : 0).run();
    }
  }

  const accessGranted = membership.masemedia && membership.moondramac;
  return json({
    ok: true,
    membership,
    membershipCheckErrors,
    accessGranted,
    missing: [!membership.masemedia ? "masemedia" : null, !membership.moondramac ? "moondramac" : null].filter(Boolean)
  });
};
