import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
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


test("dry-run mode scans with its read-only token and exits before retrieval", async () => {
  let requestBody = null;
  let authorization = null;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requestBody = JSON.parse(raw);
    authorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, count: 0, links: [] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const result = spawnSync(process.execPath, ["scripts/streamlink-recovery.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RECOVERY_DRY_RUN: "true",
        MASETV_RECOVERY_URL: `http://127.0.0.1:${port}/api/streamlink-recovery`,
        STREAMLINK_RECOVERY_SCAN_TOKEN: "dedicated-scan-only-token",
        STREAMLINK_RECOVERY_TOKEN: "",
        TELEGRAM_API_ID: "",
        TELEGRAM_API_HASH: "",
        TELEGRAM_SESSION: "",
        KDL_AIR_BOT_USERNAME: "",
        KDL_AIR_REDISTRIBUTION_AUTHORIZED: "",
        KDL_AIR_REDISTRIBUTION_AUTHORIZATION_REFERENCE: ""
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(requestBody, { action: "scan" });
    assert.equal(authorization, "Bearer dedicated-scan-only-token");
    assert.match(result.stdout, /DRY RUN ONLY/);
    assert.match(result.stdout, /"checked": 0/);
    assert.doesNotMatch(result.stdout, /Telegram retrieval|catalogue replacements were performed/);
    assert.doesNotMatch(result.stderr, /Missing required environment secret: TELEGRAM_/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
