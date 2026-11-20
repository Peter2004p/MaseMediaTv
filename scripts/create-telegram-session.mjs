import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import qrcode from "qrcode-terminal";

const apiId = Number(process.env.TELEGRAM_API_ID || "");
const apiHash = process.env.TELEGRAM_API_HASH || "";
if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
  throw new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH before running this script.");
}

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 3,
});

try {
  await client.connect();
  console.log("\nGenerating a Telegram login QR code...");
  console.log("On your Telegram phone, open Settings > Devices > Link Desktop Device.");
  console.log("Scan the QR code shown below. Do not share a screenshot or the QR token.\n");

  await client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      qrCode: async ({ token, expires }) => {
        const loginUrl = `tg://login?token=${token.toString("base64url")}`;
        console.log("\nA fresh QR code is shown below. It expires at " + new Date(expires * 1000).toLocaleTimeString() + ".\n");
        qrcode.generate(loginUrl, { small: true });
        console.log("If the QR expires, wait for the next one to appear.");
      },
      password: async (hint) => {
        console.log("\nTelegram 2-Step Verification is enabled.", hint ? "Password hint: " + hint : "");
        return input.text("Enter your Telegram 2-Step Verification password in this terminal: ");
      },
      onError: async (error) => {
        console.error("Telegram QR sign-in error:", error.errorMessage || error.message);
        return false;
      },
    }
  );

  console.log("\nTelegram login successful.");
  console.log("Your Telegram session string (keep it private):\n");
  console.log(client.session.save());
  console.log("\nCopy this value directly into GitHub Actions secret TELEGRAM_SESSION. Never post it in chat or commit it to Git.\n");
} catch (error) {
  console.error("\nTelegram QR login failed:", error.errorMessage || error.message);
  if (error.errorMessage === "AUTH_TOKEN_EXPIRED") {
    console.error("The QR expired. Run the script again and scan the newest QR.");
  } else if (error.seconds) {
    console.error("Telegram asked you to wait", error.seconds, "seconds before retrying.");
  }
  process.exitCode = 1;
} finally {
  await client.disconnect().catch(() => {});
}
