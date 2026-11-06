#!/usr/bin/env node
import assert from "node:assert/strict";

const required = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_TEST_USER_ID", "TELEGRAM_TEST_YOUTUBE_FILE_ID"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(2);
  }
}
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const userId = String(process.env.TELEGRAM_TEST_USER_ID);
const screenshotFileId = process.env.TELEGRAM_TEST_YOUTUBE_FILE_ID;
const base = (process.env.MASETV_BASE_URL || "https://masetv-cloudflare-migration.pages.dev").replace(/\/$/, "");
const webhookUrl = base + "/api/telegram/webhook/masetv";
const tg = `https://api.telegram.org/bot${token}`;

async function telegram(method, params = {}) {
  const response = await fetch(`${tg}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params)
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok && data.ok, true, `Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}
async function webhook(update) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret
    },
    body: JSON.stringify(update)
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `Webhook HTTP ${response.status}: ${JSON.stringify(data)}`);
  assert.equal(data.ok, true, `Webhook rejected update: ${JSON.stringify(data)}`);
  return data;
}
function pass(label, detail = "") {
  console.log(`PASS  ${label}${detail ? " — " + detail : ""}`);
}

console.log("MaseNet live Telegram access-gate E2E");
console.log("Target:", webhookUrl);
console.log("Test Telegram user:", userId);

const me = await telegram("getMe");
assert.ok(me.is_bot, "Configured Telegram account is not a bot");
pass("Telegram bot authentication", "@" + me.username);

const hook = await telegram("getWebhookInfo");
assert.equal(hook.url, webhookUrl, `Telegram webhook URL mismatch. Expected ${webhookUrl}, got ${hook.url || "(empty)"}`);
pass("Telegram webhook points to production");

for (const channel of ["@MaseMediaTv", "@MoonDramaC"]) {
  const member = await telegram("getChatMember", { chat_id: channel, user_id: Number(userId) });
  assert.ok(["member", "administrator", "creator"].includes(member.status),
    `${userId} is not a confirmed member of ${channel} (status: ${member.status})`);
  pass("Live membership: " + channel, member.status);
}

const file = await telegram("getFile", { file_id: screenshotFileId });
assert.ok(file.file_path, "Telegram did not return a screenshot file path");
const imageResponse = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
assert.equal(imageResponse.ok, true, "Could not download the test screenshot from Telegram");
const bytes = new Uint8Array(await imageResponse.arrayBuffer());
assert.ok(bytes.length > 0 && bytes.length <= 5_000_000, "Screenshot must be 1 byte to 5 MB");
const mime = imageResponse.headers.get("content-type") || "image/jpeg";
const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

if (process.env.OPENAI_API_KEY) {
  const vision = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      instructions: "You verify YouTube subscription screenshots. Pass only if this image clearly shows the exact channel @masemedia_tv and an active Subscribed state. Reject unclear, cropped, unrelated, or unsubscribed screenshots. Return a JSON object with boolean key passed and short string key reason, with no markdown. This is visual evidence, not cryptographic proof.",
      input: [{ role: "user", content: [
        { type: "input_text", text: "Does this screenshot clearly show @masemedia_tv as Subscribed?" },
        { type: "input_image", image_url: dataUrl }
      ] }],
      max_output_tokens: 120
    })
  });
  const visionData = await vision.json().catch(() => ({}));
  assert.equal(vision.ok, true, `OpenAI vision preflight failed: ${JSON.stringify(visionData)}`);
  const output = visionData.output_text || (visionData.output || []).flatMap(x => x.content || []).map(x => x.text || "").join("\n");
  const verdict = JSON.parse(output.match(/\{[\s\S]*\}/)?.[0] || "{}");
  assert.equal(verdict.passed, true, `Screenshot did not pass vision preflight: ${verdict.reason || output}`);
  pass("Independent YouTube screenshot vision preflight", verdict.reason || "channel and Subscribed state visible");
} else {
  console.log("SKIP  Independent vision preflight (OPENAI_API_KEY not supplied); deployed webhook performs the authoritative configured review.");
}

const updateId = Math.floor(Date.now() / 1000);
const photoUpdate = {
  update_id: updateId,
  message: {
    message_id: updateId,
    from: { id: Number(userId), is_bot: false, first_name: "MaseNet E2E test" },
    chat: { id: Number(userId), type: "private" },
    date: Math.floor(Date.now() / 1000),
    photo: [{ file_id: screenshotFileId, file_unique_id: "masenet-e2e", width: 1280, height: 720, file_size: bytes.length }]
  }
};
const photoResult = await webhook(photoUpdate);
assert.equal(photoResult.verified, true, `Live webhook did not accept the screenshot: ${JSON.stringify(photoResult)}`);
assert.equal(photoResult.accessGranted, true, `Live webhook did not grant access after all three checks: ${JSON.stringify(photoResult)}`);
pass("Production webhook accepted screenshot and granted access");

const verifyResult = await webhook({
  update_id: updateId + 1,
  message: {
    message_id: updateId + 1,
    from: { id: Number(userId), is_bot: false, first_name: "MaseNet E2E test" },
    chat: { id: Number(userId), type: "private" },
    date: Math.floor(Date.now() / 1000),
    text: "/verify"
  }
});
assert.equal(verifyResult.verified, true, `Persisted access check failed: ${JSON.stringify(verifyResult)}`);
assert.equal(verifyResult.accessGranted, true, `Persisted access was not granted: ${JSON.stringify(verifyResult)}`);
pass("Persisted verification survives a fresh /verify update");

console.log("\nALL LIVE TELEGRAM ACCESS-GATE CHECKS PASSED.");
