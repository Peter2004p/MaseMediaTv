interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
}
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function hmac(key: ArrayBuffer | Uint8Array, value: string) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}
function hex(bytes: Uint8Array) { return [...bytes].map(b => b.toString(16).padStart(2, "0")).join(""); }

/** Verifies Telegram Mini App initData on the server. Never trust initDataUnsafe on its own. */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Telegram authentication is not configured yet." }, 503);
  let body: { initData?: string };
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const initData = typeof body.initData === "string" ? body.initData : "";
  if (!initData || initData.length > 8192) return json({ error: "Missing Telegram initData." }, 400);

  const params = new URLSearchParams(initData);
  const suppliedHash = params.get("hash") || "";
  params.delete("hash");
  const authDate = Number(params.get("auth_date") || 0);
  if (!suppliedHash || !authDate || Math.abs(Date.now() / 1000 - authDate) > 86400)
    return json({ error: "Telegram login data expired or invalid." }, 401);

  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secretKey = await hmac(new TextEncoder().encode("WebAppData"), env.TELEGRAM_BOT_TOKEN);
  const expected = hex(await hmac(secretKey, dataCheckString));
  if (expected.length !== suppliedHash.length || !crypto.subtle.timingSafeEqual)
    return json({ error: "Telegram signature verification failed." }, 401);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ suppliedHash.charCodeAt(i);
  if (mismatch !== 0) return json({ error: "Telegram signature verification failed." }, 401);

  let user: { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string } | null = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch { return json({ error: "Invalid Telegram user payload." }, 401); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return json({ error: "Telegram user not found." }, 401);
  return json({ authenticated: true, provider: "telegram", user: {
    id: String(user.id), firstName: user.first_name || "", lastName: user.last_name || "",
    username: user.username || null, language: user.language_code || null
  } });
};
