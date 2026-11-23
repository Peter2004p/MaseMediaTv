import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

test("recovery runner stops at server-side preflight before scan or Telegram access", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, action: "preflight", ready: false,
      checks: { redistributionAuthorization: false, replacementHostAllowlist: false },
      blockers: ["Redistribution rights are not verified/configured.", "No approved replacement-host allowlist is configured."] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const child = spawn(process.execPath, ["scripts/streamlink-recovery.mjs"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MASETV_RECOVERY_URL: `http://127.0.0.1:${port}/api/streamlink-recovery`,
        STREAMLINK_RECOVERY_TOKEN: "dummy.token.value", TELEGRAM_API_ID: "1",
        TELEGRAM_API_HASH: "dummy", TELEGRAM_SESSION: "dummy", KDL_AIR_BOT_USERNAME: "dummy_bot" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(exitCode, 1);
    assert.match(stderr, /Recovery preflight blocked before Telegram access/);
    assert.match(stderr, /Redistribution rights are not verified/);
    assert.deepEqual(requests, [{ action: "preflight" }]);
    assert.doesNotMatch(stdout, /Scanned \\d+ saved stream variants/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
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
    const child = spawn(process.execPath, ["scripts/streamlink-recovery.mjs"], {
      stdio: ["ignore", "pipe", "pipe"],
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
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const result = { status: exitCode, stdout, stderr };
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(requestBody, { action: "scan" });
    assert.equal(authorization, "Bearer dedicated-scan-only-token");
    assert.match(result.stdout, /DRY RUN ONLY/);
    assert.match(result.stdout, /"checked": 0/);
    assert.match(result.stdout, /no Telegram retrieval and no catalogue replacements were performed/);
    assert.doesNotMatch(result.stderr, /Missing required environment secret: TELEGRAM_/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});


test("API scopes OIDC replacement to the exact recovery workflow", () => {
  const source = readFileSync(new URL("../functions/api/streamlink-recovery.ts", import.meta.url), "utf8");
  assert.match(source, /claims\.workflow_ref/);
  assert.match(source, /\.github\/workflows\/streamlink-recovery\.yml@refs\/heads\/main/);
  assert.match(source, /\.github\/workflows\/masenet-preview-recovery-dry-run\.yml@refs\/heads\/main/);
  assert.match(source, /body\.action === "scan" &&\s*\(workflowRef === recoveryWorkflowRef \|\| workflowRef === dryRunWorkflowRef\)/);
  assert.match(source, /body\.action === "preflight" && workflowRef === recoveryWorkflowRef/);
  assert.match(source, /body\.action === "replace" && workflowRef === recoveryWorkflowRef/);
  assert.match(source, /oidcPreflightAuthorized/);
  assert.match(source, /allowedHostsConfigured/);
  assert.match(source, /oidcClaims && \(oidcScanAuthorized \|\| oidcPreflightAuthorized \|\| oidcReplaceAuthorized\)/);
  assert.match(source, /KDL_AIR_REDISTRIBUTION_AUTHORIZED\?: string/);
  assert.match(source, /KDL_AIR_REDISTRIBUTION_AUTHORIZATION_REFERENCE\?: string/);
  assert.match(source, /env\.KDL_AIR_REDISTRIBUTION_AUTHORIZED !== "true" \|\| !authorizationReference/);
  assert.ok(source.indexOf("redistribution rights are verified") < source.indexOf('const allowedHosts = String(env.STREAMLINK_RECOVERY_ALLOWED_HOSTS'));
});
