import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";

const apiId = Number(process.env.TELEGRAM_API_ID || "");
const apiHash = process.env.TELEGRAM_API_HASH || "";
if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
  throw new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH from https://my.telegram.org before running this script.");
}

const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });

try {
  await client.connect();

  const phoneNumber = await input.text("Your Telegram phone number (international format): ");
  console.log("\nRequesting a Telegram login code...");
  const sent = await client.sendCode({ apiId, apiHash }, phoneNumber);

  const delivery = [];
  if (sent.isCodeViaApp) delivery.push("Telegram app");
  if (sent.isCodeViaSms) delivery.push("SMS");
  if (sent.isCodeViaCall) delivery.push("phone call");
  if (sent.isCodeViaFlashCall) delivery.push("flash call");
  if (sent.isCodeViaMissedCall) delivery.push("missed call");
  if (sent.isCodeViaFragmentSms) delivery.push("Fragment SMS");

  console.log("Telegram accepted the code request.");
  console.log("Reported delivery method:", delivery.length ? delivery.join(", ") : "not specified by Telegram");
  if (sent.timeout) console.log("Telegram retry timeout (seconds):", sent.timeout);
  if (sent.nextType) console.log("Telegram's next available delivery type:", sent.nextType.className || "provided");

  const phoneCode = await input.text("\nEnter the code from Telegram (do not share it in chat): ");
  try {
    await client.signIn({
      phoneNumber,
      phoneCodeHash: sent.phoneCodeHash,
      phoneCode
    });
  } catch (error) {
    if (error.errorMessage === "SESSION_PASSWORD_NEEDED" || error.message?.includes("SESSION_PASSWORD_NEEDED")) {
      const password = await input.text("Telegram 2-step verification password: ");
      await client.signInWithPassword({ password: async () => password });
    } else {
      throw error;
    }
  }

  console.log("\nTelegram login successful. Your session string (keep it private):\n");
  console.log(client.session.save());
  console.log("\nCopy this value directly into the GitHub Actions secret TELEGRAM_SESSION. Never post it in a chat or commit it to Git.\n");
} catch (error) {
  console.error("\nTelegram login failed:", error.errorMessage || error.message);
  if (error.errorMessage === "PHONE_CODE_INVALID") {
    console.error("The entered code was not accepted. Check the newest code and do not reuse an older one.");
  } else if (error.errorMessage === "PHONE_CODE_EXPIRED") {
    console.error("The code expired. Wait for Telegram's stated retry window before requesting another.");
  } else if (error.errorMessage === "FLOOD") {
    console.error("Telegram is rate-limiting login attempts. Stop retrying and wait before trying again.");
  }
  process.exitCode = 1;
} finally {
  await client.disconnect().catch(() => {});
}
