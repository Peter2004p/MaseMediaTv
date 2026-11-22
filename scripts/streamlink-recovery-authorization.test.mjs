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
