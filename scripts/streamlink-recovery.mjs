import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

const required = ["MASETV_RECOVERY_URL", "STREAMLINK_RECOVERY_SECRET", "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION", "KDL_AIR_BOT_USERNAME"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment secret: ${key}`);
}
const recoveryEndpoint = new URL(process.env.MASETV_RECOVERY_URL);
if (!recoveryEndpoint.pathname.replace(/\/$/, "").endsWith("/api/streamlink-recovery")) {
  recoveryEndpoint.pathname = `${recoveryEndpoint.pathname.replace(/\/$/, "")}/api/streamlink-recovery`;
}
const recoveryUrl = recoveryEndpoint.toString();
const authHeaders = {
  Authorization: `Bearer ${process.env.STREAMLINK_RECOVERY_SECRET}`,
  "Content-Type": "application/json"
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function recoveryApi(action, payload = {}) {
  const response = await fetch(recoveryUrl, {
    method: "POST", headers: authHeaders, body: JSON.stringify({ action, ...payload })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `MaseNet recovery API returned HTTP ${response.status}`);
  return data;
}

function isPublicIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, d] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 0 && (d === 0 || d === 2)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && d === 113) return false;
  return true;
}

function isPublicIPv6(address) {
  const value = address.toLowerCase().split("%")[0];
  if (value.startsWith("::ffff:") || value === "::" || value === "::1") return false;
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  // Accept only global-unicast 2000::/3; reject documentation and transition ranges.
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  if (value.startsWith("2001:db8:") || value.startsWith("2001:10:") || value.startsWith("2002:")) return false;
  return true;
}

async function resolvePublicTarget(url) {
  const hostname = url.hostname.toLowerCase().replace(/^\\[|\\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Blocked non-public media hostname.");
  }
  const literalFamily = isIP(hostname);
  if (literalFamily) throw new Error("IP-literal stream URLs are not allowed.");
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record =>
    record.family === 4 ? !isPublicIPv4(record.address) :
    record.family === 6 ? !isPublicIPv6(record.address) : true
  )) {
    throw new Error("Media hostname resolves to a non-public or mixed address set.");
  }
  // Pin the connection to one validated address to reduce DNS-rebinding/TOCTOU risk.
  return records[0];
}

async function requestPinnedStatus(url, method, headers, target) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: url.hostname,
      port: 443,
      method,
      path: url.pathname + url.search,
      headers: { "User-Agent": "MaseNet-Link-Recovery/1.0", ...headers },
      servername: url.hostname,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [target]);
        else callback(null, target.address, target.family);
      }
    }, response => {
      const status = response.statusCode || 0;
      response.resume();
      response.on("end", () => resolve(status));
      response.on("error", reject);
    });
    request.setTimeout(9000, () => request.destroy(new Error("Media probe timed out.")));
    request.on("error", reject);
    request.end();
  });
}

async function checkLink(value) {
  let url;
  try {
    url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        (url.port && url.port !== "443")) {
      return { expired: false, reason: "unsafe-url-inconclusive" };
    }
    const target = await resolvePublicTarget(url);
    const headStatus = await requestPinnedStatus(url, "HEAD", {}, target);
    // HEAD alone never proves expiry; confirm with two bounded GET requests.
    if (![404, 410, 405, 501].includes(headStatus)) {
      return { expired: false, reason: headStatus === 401 || headStatus === 403
        ? "access-denied-inconclusive" : `http-${headStatus}` };
    }
    const firstGet = await requestPinnedStatus(url, "GET", { Range: "bytes=0-0" }, target);
    if (![404, 410].includes(firstGet)) {
      return { expired: false, reason: `get-http-${firstGet}` };
    }
    await sleep(2500);
    const confirmGet = await requestPinnedStatus(url, "GET", { Range: "bytes=0-0" }, target);
    return {
      expired: [404, 410].includes(confirmGet),
      reason: `confirmed-get-http-${confirmGet}`
    };
  } catch (error) {
    return { expired: false, reason: `probe-inconclusive: ${error.message}` };
  }
}

const buttonList = message => (message?.replyMarkup?.rows || [])
  .flatMap(row => row.buttons || [])
  .map(button => ({ button, text: String(button.text || "").trim() }));

async function clickMatching(client, peer, messages, pattern, label, minMessageId = 0) {
  // Ignore outgoing messages and every bot message that predates this lookup.
  const freshMessages = messages
    .filter(message => !message.out && Number(message.id) > minMessageId)
    .sort((a, b) => Number(b.id) - Number(a.id));
  for (const message of freshMessages) {
    for (const item of buttonList(message)) {
      if (!pattern.test(item.text)) continue;
      if (!item.button.data) throw new Error(`The ${label} button is not a supported callback button.`);
      await client.invoke(new Api.messages.GetBotCallbackAnswer({
        peer, msgId: message.id, data: item.button.data
      }));
      await sleep(1200);
      return true;
    }
  }
  return false;
}

async function waitFor(client, peer, predicate, description, timeoutMs = 25000, minMessageId = 0) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const messages = await client.getMessages(peer, { limit: 30 });
    const found = messages.find(message =>
      !message.out && Number(message.id) > minMessageId && predicate(message)
    );
    if (found) return { message: found, messages };
    await sleep(1200);
  }
  throw new Error(`Timed out waiting for KDL Air: ${description}`);
}

const normalizeTitle = value => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("en")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim();

function responseMatchesExactTitle(message, title) {
  const expected = normalizeTitle(title);
  if (!expected) return false;
  const visible = [
    String(message.message || ""),
    ...buttonList(message).map(item => item.text)
  ].map(normalizeTitle);
  return visible.some(value => value === expected);
}

async function collectFreshLink(client, peer, item) {
  const seasonText = `S${String(item.season).padStart(2, "0")}`;
  const episodeText = `S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`;
  const sent = await client.sendMessage(peer, { message: item.title });
  const sentId = Number(sent?.id || 0);

  // Only accept a fresh bot response that visibly identifies the exact title.
  // Similar titles and stale buttons from an earlier lookup must never be used.
  let state = await waitFor(client, peer,
    message => Number(message.id) > sentId &&
      responseMatchesExactTitle(message, item.title) &&
      buttonList(message).some(x => /quality/i.test(x.text)),
    `an exact-title result for "${item.title}" with a quality selector`, 25000, sentId);

  const qualityOpened = await clickMatching(client, peer, state.messages, /^quality$/i, "Quality", sentId);
  if (!qualityOpened) throw new Error("KDL Air did not expose its Quality filter; refusing to guess a stream variant.");

  state = await waitFor(client, peer,
    message => buttonList(message).some(x => new RegExp(`^\\s*${item.quality}\\s*$`, "i").test(x.text)),
    `the ${item.quality} quality option`, 25000, sentId);
  const qualityChosen = await clickMatching(client, peer, state.messages,
    new RegExp(`^\\s*${item.quality}\\s*import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const required = ["MASETV_RECOVERY_URL", "STREAMLINK_RECOVERY_SECRET", "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION", "KDL_AIR_BOT_USERNAME"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment secret: ${key}`);
}
const recoveryEndpoint = new URL(process.env.MASETV_RECOVERY_URL);
if (!recoveryEndpoint.pathname.replace(/\/$/, "").endsWith("/api/streamlink-recovery")) {
  recoveryEndpoint.pathname = `${recoveryEndpoint.pathname.replace(/\/$/, "")}/api/streamlink-recovery`;
}
const recoveryUrl = recoveryEndpoint.toString();
const authHeaders = {
  Authorization: `Bearer ${process.env.STREAMLINK_RECOVERY_SECRET}`,
  "Content-Type": "application/json"
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function recoveryApi(action, payload = {}) {
  const response = await fetch(recoveryUrl, {
    method: "POST", headers: authHeaders, body: JSON.stringify({ action, ...payload })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `MaseNet recovery API returned HTTP ${response.status}`);
  return data;
}

async function checkLink(url) {
  const request = async (method, headers = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(url, {
        method, redirect: "manual", signal: controller.signal,
        headers: { "User-Agent": "MaseNet-Link-Recovery/1.0", ...headers }
      });
      try { await response.body?.cancel(); } catch {}
      return response.status;
    } finally { clearTimeout(timer); }
  };

  // HEAD is only a quick probe. Some hosts incorrectly return 404/410 to
  // HEAD while the actual media GET still works, so never expire on HEAD alone.
  let headStatus;
  try {
    headStatus = await request("HEAD");
  } catch {
    return { expired: false, reason: "network-inconclusive" };
  }
  if (![404, 410, 405, 501].includes(headStatus)) {
    return { expired: false, reason: headStatus === 401 || headStatus === 403
      ? "access-denied-inconclusive" : `http-${headStatus}` };
  }

  // Confirm with a one-byte GET. Only repeated GET 404/410 responses count.
  let firstGet;
  try {
    firstGet = await request("GET", { Range: "bytes=0-0" });
  } catch {
    return { expired: false, reason: "get-network-inconclusive" };
  }
  if (![404, 410].includes(firstGet)) {
    return { expired: false, reason: `get-http-${firstGet}` };
  }

  await sleep(2500);
  try {
    const confirmGet = await request("GET", { Range: "bytes=0-0" });
    return {
      expired: [404, 410].includes(confirmGet),
      reason: `confirmed-get-http-${confirmGet}`
    };
  } catch {
    return { expired: false, reason: "confirmation-network-inconclusive" };
  }
}

const buttonList = message => (message?.replyMarkup?.rows || [])
  .flatMap(row => row.buttons || [])
  .map(button => ({ button, text: String(button.text || "").trim() }));

async function clickMatching(client, peer, messages, pattern, label, minMessageId = 0) {
  // Ignore outgoing messages and every bot message that predates this lookup.
  const freshMessages = messages
    .filter(message => !message.out && Number(message.id) > minMessageId)
    .sort((a, b) => Number(b.id) - Number(a.id));
  for (const message of freshMessages) {
    for (const item of buttonList(message)) {
      if (!pattern.test(item.text)) continue;
      if (!item.button.data) throw new Error(`The ${label} button is not a supported callback button.`);
      await client.invoke(new Api.messages.GetBotCallbackAnswer({
        peer, msgId: message.id, data: item.button.data
      }));
      await sleep(1200);
      return true;
    }
  }
  return false;
}

async function waitFor(client, peer, predicate, description, timeoutMs = 25000, minMessageId = 0) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const messages = await client.getMessages(peer, { limit: 30 });
    const found = messages.find(message =>
      !message.out && Number(message.id) > minMessageId && predicate(message)
    );
    if (found) return { message: found, messages };
    await sleep(1200);
  }
  throw new Error(`Timed out waiting for KDL Air: ${description}`);
}

const normalizeTitle = value => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("en")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim();

function responseMatchesExactTitle(message, title) {
  const expected = normalizeTitle(title);
  if (!expected) return false;
  const visible = [
    String(message.message || ""),
    ...buttonList(message).map(item => item.text)
  ].map(normalizeTitle);
  return visible.some(value => value === expected);
}

async function collectFreshLink(client, peer, item) {
  const seasonText = `S${String(item.season).padStart(2, "0")}`;
  const episodeText = `S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`;
  const sent = await client.sendMessage(peer, { message: item.title });
  const sentId = Number(sent?.id || 0);

  // Only accept a fresh bot response that visibly identifies the exact title.
  // Similar titles and stale buttons from an earlier lookup must never be used.
  let state = await waitFor(client, peer,
    message => Number(message.id) > sentId &&
      responseMatchesExactTitle(message, item.title) &&
      buttonList(message).some(x => /quality/i.test(x.text)),
    `an exact-title result for "${item.title}" with a quality selector`, 25000, sentId);

  const qualityOpened = await clickMatching(client, peer, state.messages, /^quality$/i, "Quality", sentId);
  if (!qualityOpened) throw new Error("KDL Air did not expose its Quality filter; refusing to guess a stream variant.");

  state = await waitFor(client, peer,
    message => buttonList(message).some(x => new RegExp(`^\\s*${item.quality}\\s*$`, "i").test(x.text)),
    `the ${item.quality} quality option`, 25000, sentId);
  const qualityChosen = await clickMatching(client, peer, state.messages,
, "i"), "quality option", sentId);
  if (!qualityChosen) throw new Error(`KDL Air did not offer ${item.quality}; no other quality will be substituted.`);

  if (Number(item.season) > 1) {
    state = await waitFor(client, peer,
      message => buttonList(message).some(x => /season/i.test(x.text)),
      "season selector", 12000, sentId);
    const seasonOpened = await clickMatching(client, peer, state.messages, /^season$/i, "Season", sentId);
    if (!seasonOpened) throw new Error("Season selector unavailable.");
    state = await waitFor(client, peer,
      message => buttonList(message).some(x => new RegExp(`(?:^|\\b)${seasonText}(?:\\b|$)|^\\s*${item.season}\\s*$`, "i").test(x.text)),
      `${seasonText} option`, 25000, sentId);
    const seasonChosen = await clickMatching(client, peer, state.messages,
      new RegExp(`(?:^|\\b)${seasonText}(?:\\b|$)|^\\s*${item.season}\\s*$`, "i"), "season option", sentId);
    if (!seasonChosen) throw new Error(`KDL Air did not offer ${seasonText}.`);
  }

  state = await waitFor(client, peer,
    message => buttonList(message).some(x => new RegExp(episodeText, "i").test(x.text)),
    `${episodeText} episode`, 25000, sentId);
  const episodeChosen = await clickMatching(client, peer, state.messages, new RegExp(episodeText, "i"), "episode", sentId);
  if (!episodeChosen) throw new Error(`KDL Air did not expose ${episodeText} as a selectable button.`);

  state = await waitFor(client, peer,
    message => buttonList(message).some(x => /generate streamlink/i.test(x.text)),
    "Generate Streamlink button", 25000, sentId);
  const generated = await clickMatching(client, peer, state.messages, /generate streamlink/i, "Generate Streamlink", sentId);
  if (!generated) throw new Error("Generate Streamlink button was unavailable.");

  state = await waitFor(client, peer,
    message => /your link\s*:/i.test(String(message.message || "")) &&
      /https:\/\//i.test(String(message.message || "")),
    "generated streamlink", 45000, sentId);
  const text = String(state.message.message || "");
  const match = text.match(/your link\s*:\s*(https:\/\/[^\s<>]+)/i);
  if (!match) throw new Error("KDL Air response did not contain a readable streamlink.");
  const freshUrl = match[1].replace(/[),.]+$/, "");
  let filename = "";
  try { filename = decodeURIComponent(new URL(freshUrl).pathname.split("/").pop() || ""); } catch {}
  const freshQuality = filename.match(/\b(2160p|1440p|1080p|720p|576p|540p|480p|360p)\b/i)?.[1]?.toLowerCase();
  const freshCodec = filename.match(/\b(x265|h265|hevc|x264|h264|av1)\b/i)?.[1]?.toLowerCase();
  const expectedCodec = String(item.codec || "Unknown").toLowerCase();
  const aliases = { hevc: "x265", h265: "x265", h264: "x264" };
  if (freshQuality !== String(item.quality).toLowerCase()) throw new Error("KDL Air returned a different quality; replacement was blocked.");
  if (!freshCodec || (aliases[freshCodec] || freshCodec) !== (aliases[expectedCodec] || expectedCodec)) {
    throw new Error("KDL Air returned a different or unidentified codec; replacement was blocked.");
  }
  return freshUrl;
}

async function main() {
  const scan = await recoveryApi("scan");
  console.log(`Scanned ${scan.count} saved stream variants.`);
  const expired = [];
  const links = scan.links || [];
  for (let offset = 0; offset < links.length; offset += 12) {
    const batch = links.slice(offset, offset + 12);
    const checks = await Promise.all(batch.map(async item => ({ item, result: await checkLink(item.streamUrl) })));
    for (const { item, result } of checks) {
      if (result.expired) {
        console.log(`Confirmed expired: ${item.title} S${item.season}E${item.episode} ${item.quality}`);
        expired.push(item);
      }
    }
  }
  if (!expired.length) {
    console.log("No confirmed expired links. No catalogue changes made.");
    return;
  }

  const client = new TelegramClient(
    new StringSession(process.env.TELEGRAM_SESSION),
    Number(process.env.TELEGRAM_API_ID),
    process.env.TELEGRAM_API_HASH,
    { connectionRetries: 3, autoReconnect: true }
  );
  await client.connect();
  try {
    const peer = await client.getEntity(process.env.KDL_AIR_BOT_USERNAME);
    for (const item of expired) {
      try {
        const newUrl = await collectFreshLink(client, peer, item);
        const updated = await recoveryApi("replace", {
          titleId: item.titleId, episodeId: item.episodeId, episodeIndex: item.episodeIndex,
          oldUrl: item.streamUrl, newUrl, quality: item.quality, codec: item.codec
        });
        console.log(`Replaced ${updated.title} S${updated.season}E${updated.episode} ${updated.quality} only.`);
      } catch (error) {
        console.error(`Recovery failed for ${item.title} ${item.episodeId} ${item.quality}:`, error.message);
      }
      await sleep(1800);
    }
  } finally {
    await client.disconnect();
  }
}

main().catch(error => {
  console.error("Streamlink recovery run failed:", error);
  process.exitCode = 1;
});
