import { json } from "../auth/_shared";
interface Env { DB: D1Database; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_BOT_USERNAME?: string; }
export const onRequestGet = async ({ env }: { env: Env }) => {
  const row = await env.DB.prepare("SELECT value_json FROM site_settings WHERE key='telegram_webhook'").first<{value_json:string}>();
  let webhookConfigured = false;
  try { webhookConfigured = Boolean(row && JSON.parse(row.value_json).configured === true); } catch {}
  const botConfigured = Boolean(env.TELEGRAM_BOT_TOKEN);
  const username = (env.TELEGRAM_BOT_USERNAME || "MaseTv_Bot").replace(/^@/, "");
  return json({
    configured: botConfigured && webhookConfigured,
    botConfigured,
    webhookConfigured,
    username,
    botUrl: "https://t.me/" + username,
    miniAppReady: false,
    note: !botConfigured ? "Telegram bot token has not been configured in Cloudflare." : !webhookConfigured ? "Bot token exists, but the webhook has not been registered and verified." : "Webhook registration was recorded; complete an end-to-end bot test before cutover."
  });
};