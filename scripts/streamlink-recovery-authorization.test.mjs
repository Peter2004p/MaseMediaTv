import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

test("recovery runner refuses to start without explicit redistribution authorization", () => {
  const result = spawnSync(process.execPath, ["scripts/streamlink-recovery.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MASETV_RECOVERY_URL: "https://preview.example/api/streamlink-recovery",
      STREAMLINK_RECOVERY_TOKEN: "dummy.token.value",
      TELEGRAM_API_ID: "1",
      TELEGRAM_API_HASH: "dummy",
      TELEGRAM_SESSION: "dummy",
      KDL_AIR_BOT_USERNAME: "dummy_bot",
      KDL_AIR_REDISTRIBUTION_AUTHORIZED: "",
      KDL_AIR_REDISTRIBUTION_AUTHORIZATION_REFERENCE: ""
    }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /KDL Air recovery is disabled: verify redistribution rights/);
  assert.doesNotMatch(result.stderr, /Scanned \d+ saved stream variants/);
});


test("dry-run mode does not require Telegram credentials or redistribution authorization", () => {
  const result = spawnSync(process.execPath, ["scripts/streamlink-recovery.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RECOVERY_DRY_RUN: "true",
      MASETV_RECOVERY_URL: "http://127.0.0.1:1/api/streamlink-recovery",
      STREAMLINK_RECOVERY_SCAN_TOKEN: "dummy-preview-read-token",
      STREAMLINK_RECOVERY_TOKEN: "",
      TELEGRAM_API_ID: "",
      TELEGRAM_API_HASH: "",
      TELEGRAM_SESSION: "",
      KDL_AIR_BOT_USERNAME: "",
      KDL_AIR_REDISTRIBUTION_AUTHORIZED: "",
      KDL_AIR_REDISTRIBUTION_AUTHORIZATION_REFERENCE: ""
    }
  });
  assert.equal(result.status, 1); // The deliberately unreachable local API must fail.
  assert.doesNotMatch(result.stderr, /Missing required environment secret: TELEGRAM_/);
  assert.doesNotMatch(result.stderr, /Missing required environment secret: STREAMLINK_RECOVERY_SCAN_TOKEN/);
  assert.doesNotMatch(result.stderr, /KDL Air recovery is disabled/);
  assert.match(result.stderr, /fetch failed|ECONNREFUSED|Failed to fetch/i);
});
