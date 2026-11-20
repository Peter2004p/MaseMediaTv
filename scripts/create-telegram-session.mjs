import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";

const apiId = Number(process.env.TELEGRAM_API_ID || "");
const apiHash = process.env.TELEGRAM_API_HASH || "";
if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
  throw new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH before running this script.");
}

const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });

try {
  await client.start({
    phoneNumber: async () => input.text("Your Telegram phone number (international format): "),
    phoneCode: async (isCodeViaApp) => {
      console.log("\nTelegram requested the login code.");
      console.log("Delivery method:", isCodeViaApp ? "Telegram app" : "SMS or another Telegram-selected method");
      return input.text("Enter the newest Telegram login code (never share it): ");
    },
    password: async (hint) => {
      console.log("Telegram 2-step verification is enabled.", hint ? "Password hint: " + hint : "");
      return input.text("Telegram 2-step verification password (never share it): ");
    },
    onError: (error) => {
      console.error("Telegram sign-in error:", error.errorMessage || error.message);
      return false;
    }
  });

  console.log("\nTelegram login successful.");
  console.log("Your Telegram session string (keep it private):\n");
  console.log(client.session.save());
  console.log("\nCopy this value directly into the GitHub Actions secret TELEGRAM_SESSION. Never post it in chat or commit it to Git.\n");
} catch (error) {
  console.error("\nTelegram login failed:", error.errorMessage || error.message);
  if (error.errorMessage === "PHONE_CODE_INVALID") {
    console.error("The code was not accepted. Request a fresh code and use only the newest one.");
  } else if (error.errorMessage === "PHONE_CODE_EXPIRED") {
    console.error("The code expired. Wait before requesting another.");
  } else if (error.seconds) {
    console.error("Telegram asked you to wait", error.seconds, "seconds before retrying.");
  }
  process.exitCode = 1;
} finally {
  await client.disconnect().catch(() => {});
}
