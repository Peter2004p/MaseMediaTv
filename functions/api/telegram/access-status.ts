interface Env { DB: D1Database; TELEGRAM_BOT_TOKEN?: string; }
type TelegramMemberResult = { ok?: boolean; result?: { status?: string }; description?: string };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function hmac(key: BufferSource, data: string) {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(data)));
}
const hex = (value: Uint8Array) => [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function checkMembership(token: string, channel: string, userId: string) {
  try {
    const url = "https://api.telegram.org/bot" + token + "/getChatMember?chat_id=" + encodeURIComponent(channel) + "&user_id=" + encodeURIComponent(userId);
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await response.json().catch(() => ({})) as TelegramMemberResult;
    if (!response.ok || !data.ok) {
      return { member: false, error: data.description || "Telegram could not confirm membership. The bot may need administrator access in this channel." };
    }
    const status = String(data.result?.status || "");
    return { member: ["member", "administrator", "creator"].includes(status), error: "" };
  } catch {
    return { member: false, error: "Telegram membership check timed out. Please refresh and try again." };
  }
}

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Telegram verification is not configured." }, 503);
  const body = await request.json().catch(() => ({})) as { initData?: string };
  const initData = String(body.initData || "");
  if (!initData || initData.length > 8192) return json({ error: "Open MaseNet inside Telegram and retry." }, 400);

  const params = new URLSearchParams(initData);
  const suppliedHash = params.get("hash") || "";
  params.delete("hash");
  const authDate = Number(params.get("auth_date") || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!suppliedHash || !authDate || authDate > now + 60 || now - authDate > 86400) {
    return json({ error: "Your Telegram session expired. Close and reopen MaseNet from the bot." }, 401);
  }

  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  const checkString = entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), env.TELEGRAM_BOT_TOKEN);
  const expectedHash = hex(await hmac(secret, checkString));
  if (!constantTimeEqual(expectedHash, suppliedHash)) return json({ error: "Telegram session validation failed. Reopen the Mini App and retry." }, 401);

  let user: { id?: number | string } | null = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch {}
  if (!user?.id) return json({ error: "Telegram user was not found in this session." }, 401);
  const chatId = String(user.id);

  await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_access_verification (chat_id TEXT PRIMARY KEY, youtube_ok INTEGER NOT NULL DEFAULT 0, masemedia_ok INTEGER NOT NULL DEFAULT 0, moondramac_ok INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  const saved = await env.DB.prepare("SELECT youtube_ok FROM telegram_access_verification WHERE chat_id=?").bind(chatId).first<{ youtube_ok: number }>();

  const [main, second] = await Promise.all([
    checkMembership(env.TELEGRAM_BOT_TOKEN, "@MaseMediaTv", chatId),
    checkMembership(env.TELEGRAM_BOT_TOKEN, "@MoonDramaC", chatId)
  ]);
  const membership = { masemedia: main.member, moondramac: second.member };
  await env.DB.prepare("INSERT INTO telegram_access_verification (chat_id,masemedia_ok,moondramac_ok,updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET masemedia_ok=excluded.masemedia_ok,moondramac_ok=excluded.moondramac_ok,updated_at=datetime('now')")
    .bind(chatId, main.member ? 1 : 0, second.member ? 1 : 0).run();

  const youtubeVerified = !!saved?.youtube_ok;
  const accessGranted = youtubeVerified && main.member && second.member;
  const missing = [!youtubeVerified ? "youtube" : null, !main.member ? "masemedia" : null, !second.member ? "moondramac" : null].filter(Boolean);
  return json({
    ok: true,
    youtubeVerified,
    membership,
    accessGranted,
    missing,
    checkErrors: { masemedia: main.error || null, moondramac: second.error || null }
  });
};
