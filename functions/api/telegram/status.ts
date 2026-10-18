import { json } from "../auth/_shared";
interface Env { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_BOT_USERNAME?: string; }
export const onRequestGet = ({ env }: { env: Env }) => json({
  configured: Boolean(env.TELEGRAM_BOT_TOKEN),
  username: (env.TELEGRAM_BOT_USERNAME || "MaseTv_Bot").replace(/^@/, ""),
  botUrl: "https://t.me/" + (env.TELEGRAM_BOT_USERNAME || "MaseTv_Bot").replace(/^@/, ""),
  miniAppReady: false,
  note: env.TELEGRAM_BOT_TOKEN ? "Bot token is configured; webhook and Mini App validation still need verification." : "Telegram bot token has not been configured in Cloudflare yet."
});