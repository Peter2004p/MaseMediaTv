import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";

const apiId = Number(process.env.TELEGRAM_API_ID || "");
const apiHash = process.env.TELEGRAM_API_HASH || "";
if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
  throw new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH from https://my.telegram.org before running this script.");
}

const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
await client.start({
  phoneNumber: async () => input.text("Your Telegram phone number (international format): "),
  phoneCode: async () => input.text("Login code sent by Telegram: "),
  password: async () => input.text("Telegram 2-step verification password (if enabled): "),
  onError: error => console.error("Telegram sign-in error:", error.message)
});

console.log("\nYour Telegram user session string (keep it private):\n");
console.log(client.session.save());
console.log("\nCopy this value directly into the GitHub Actions secret TELEGRAM_SESSION. Never post it in a chat or commit it to Git.\n");
await client.disconnect();
