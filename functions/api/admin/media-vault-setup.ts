import { json, requireOwner, type Env as AuthEnv } from "../auth/_shared";
import { saveMediaVaultConfig } from "./_media-vault-config";

interface Env extends AuthEnv { MASE_STREAM_BOT_WEBHOOK_SECRET?: string; }
const telegram = async (token: string, method: string, payload?: Record<string, unknown>) => {
  const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "content-type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined
  });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; description?: string; result?: any };
  if (!response.ok || !data.ok) throw new Error(data.description || "Telegram API request failed.");
  return data.result;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireOwner(request, env);
  if (gate.response) return gate.response;
  if (request.headers.get("Origin") !== new URL(request.url).origin) return json({ ok:false, error:"Same-origin confirmation is required." }, 403);
  const encryptionSecret = String(env.MASE_STREAM_BOT_WEBHOOK_SECRET || "").trim();
  if (!encryptionSecret) return json({ ok:false, error:"Preview's vault encryption key is missing. The setup cannot safely store credentials." }, 503);
  let body: { token?: string; adminChatId?: string; vaultChatId?: string };
  try { body = await request.json() as typeof body; } catch { return json({ ok:false, error:"Invalid setup request." }, 400); }
  const token = String(body.token || "").trim();
  const adminChatId = String(body.adminChatId || "").trim();
  const vaultChatId = String(body.vaultChatId || "").trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) return json({ ok:false, error:"That does not look like a valid Telegram bot token." }, 400);
  if (!/^\d{5,}$/.test(adminChatId)) return json({ ok:false, error:"Enter the numeric Telegram user ID that owns the manager bot." }, 400);
  if (!/^-100\d{5,}$/.test(vaultChatId)) return json({ ok:false, error:"Enter the private Telegram channel ID, including its -100 prefix." }, 400);
  try {
    const me = await telegram(token, "getMe");
    const admin = await telegram(token, "getChat", { chat_id: adminChatId });
    if (String(admin.type) !== "private" || String(admin.id) !== adminChatId) {
      return json({ ok:false, error:"The owner ID must be a private chat with this bot. Open @"+String(me.username||"the manager bot")+" and press Start first." }, 400);
    }
    const vault = await telegram(token, "getChat", { chat_id: vaultChatId });
    const membership = await telegram(token, "getChatMember", { chat_id: vaultChatId, user_id: me.id });
    if (!["administrator","creator"].includes(String(membership.status)) || membership.can_post_messages === false) {
      return json({ ok:false, error:"Add @"+String(me.username||"the manager bot")+" as a channel administrator with permission to post, then retry." }, 400);
    }
    await saveMediaVaultConfig(env.DB, encryptionSecret, {
      token, adminChatId, vaultChatId, botUsername: String(me.username || ""),
      vaultTitle: String(vault.title || "Private Media Vault")
    });
    return json({ ok:true, configured:true, botUsername:String(me.username||""), vaultTitle:String(vault.title||"Private Media Vault"), message:"Manager bot verified. Its credentials are encrypted in the Preview database." });
  } catch (error) {
    return json({ ok:false, error:error instanceof Error ? error.message : "Telegram setup verification failed." }, 502);
  }
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireOwner(request, env);
  if (gate.response) return gate.response;
  const secret = String(env.MASE_STREAM_BOT_WEBHOOK_SECRET || "").trim();
  if (!secret) return json({ ok:true, configured:false });
  const row = await env.DB.prepare("SELECT bot_username,vault_title,updated_at FROM telegram_media_vault_config WHERE id=1")
    .first<{bot_username:string;vault_title:string;updated_at:string}>().catch(() => null);
  return json({ ok:true, configured:!!row, botUsername:row?.bot_username||"", vaultTitle:row?.vault_title||"", updatedAt:row?.updated_at||null });
};
