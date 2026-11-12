#!/usr/bin/env node
import assert from "node:assert/strict";

// Safe production smoke test for the current Mini App verification architecture.
// This deliberately does NOT forge Telegram webhook updates or grant verification.
const required = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_TEST_INIT_DATA"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(2);
  }
}
const token = process.env.TELEGRAM_BOT_TOKEN;
const initData = process.env.TELEGRAM_TEST_INIT_DATA;
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
function pass(label, detail = "") {
  console.log(`PASS  ${label}${detail ? " — " + detail : ""}`);
}

console.log("MaseNet production Telegram verification smoke test");
console.log("Target:", base);

const me = await telegram("getMe");
assert.ok(me.is_bot, "Configured Telegram account is not a bot");
pass("Telegram bot authentication", "@" + me.username);

const hook = await telegram("getWebhookInfo");
assert.equal(hook.url, webhookUrl, `Telegram webhook URL mismatch. Expected ${webhookUrl}, got ${hook.url || "(empty)"}`);
pass("Telegram webhook points to production");

const response = await fetch(base + "/api/telegram/access-status", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ initData })
});
const status = await response.json().catch(() => ({}));
assert.equal(response.status, 200, `Mini App access-status HTTP ${response.status}: ${JSON.stringify(status)}`);
assert.equal(status.ok, true, "Mini App access-status did not return ok=true");
assert.equal(typeof status.membership?.masemedia, "boolean", "MaseMediaTv membership status missing");
assert.equal(typeof status.membership?.moondramac, "boolean", "MoonDramaC membership status missing");
pass("Signed Telegram Mini App initData validation");
pass("Live channel membership check", `MaseMediaTv=${status.membership.masemedia}; MoonDramaC=${status.membership.moondramac}`);
pass("Access decision", status.accessGranted ? "access granted" : "verification still required");
if (process.env.TELEGRAM_TEST_EXPECT_ACCESS === "true") {
  assert.equal(status.accessGranted, true, "Test account does not currently have access");
}
if (status.latestSubmission) {
  pass("Latest screenshot review state", `${status.latestSubmission.status}; AI=${status.latestSubmission.ai_verdict || "not yet recorded"}`);
} else {
  pass("Screenshot review state", "no submission exists for this test account yet");
}

console.log("\nALL NON-DESTRUCTIVE TELEGRAM SMOKE CHECKS PASSED.");
console.log("Note: screenshot submission and the 5-second admin/AI review are intentionally not simulated; test those by submitting a real screenshot from the Mini App.");
