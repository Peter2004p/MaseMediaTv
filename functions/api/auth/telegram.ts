import { json } from "./_shared";
interface Env { TELEGRAM_BOT_TOKEN?: string; }
async function hmac(key: BufferSource, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new TextEncoder().encode(data);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, bytes));
}
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Telegram bot is not configured" }, 503);
  const body = await request.json().catch(() => ({})) as { initData?: string };
  const initData = String(body.initData || "");
  if (!initData || initData.length > 8192) return json({ error: "Missing Telegram initData" }, 400);
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  params.delete("hash");
  const authDate = Number(params.get("auth_date") || 0);
  if (!hash || !authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return json({ error: "Expired or invalid Telegram session" }, 401);
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  const check = entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value).join("\n");
  const keyBytes = new TextEncoder().encode("WebAppData");
  const secret = await hmac(keyBytes.buffer as ArrayBuffer, env.TELEGRAM_BOT_TOKEN);
  const sig = await hmac(secret.buffer.slice(secret.byteOffset, secret.byteOffset + secret.byteLength) as ArrayBuffer, check);
  const expected = [...sig].map(x => x.toString(16).padStart(2, "0")).join("");
  if (expected !== hash) return json({ error: "Telegram signature validation failed" }, 401);
  let user: { id?: string | number; first_name?: string; last_name?: string } | null = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch {}
  if (!user?.id) return json({ error: "Telegram user data missing" }, 401);
  return json({ user: { userId: String(user.id), name: [user.first_name, user.last_name].filter(Boolean).join(" "), email: "", provider: "telegram" } });
};
