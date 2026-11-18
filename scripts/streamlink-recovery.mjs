import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const required = ["MASETV_RECOVERY_URL", "STREAMLINK_RECOVERY_SECRET", "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION", "KDL_AIR_BOT_USERNAME"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment secret: ${key}`);
}
const baseUrl = process.env.MASETV_RECOVERY_URL.replace(/\/$/, "");
const authHeaders = {
  Authorization: `Bearer ${process.env.STREAMLINK_RECOVERY_SECRET}`,
  "Content-Type": "application/json"
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function recoveryApi(action, payload = {}) {
  const response = await fetch(`${baseUrl}/api/streamlink-recovery`, {
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
  let status;
  try {
    status = await request("HEAD");
    if ([405, 501].includes(status)) status = await request("GET", { Range: "bytes=0-0" });
  } catch {
    return { expired: false, reason: "network-inconclusive" };
  }
  if (![404, 410].includes(status)) {
    return { expired: false, reason: status === 401 || status === 403 ? "access-denied-inconclusive" : `http-${status}` };
  }
  await sleep(2500);
  try {
    let confirm = await request("HEAD");
    if ([405, 501].includes(confirm)) confirm = await request("GET", { Range: "bytes=0-0" });
    return { expired: [404, 410].includes(confirm), reason: `confirmed-http-${confirm}` };
  } catch {
    return { expired: false, reason: "confirmation-network-inconclusive" };
  }
}

const buttonList = message => (message?.replyMarkup?.rows || [])
  .flatMap(row => row.buttons || [])
  .map(button => ({ button, text: String(button.text || "").trim() }));

async function clickMatching(client, peer, messages, pattern, label) {
  for (const message of messages) {
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

async function waitFor(client, peer, predicate, description, timeoutMs = 25000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const messages = await client.getMessages(peer, { limit: 30 });
    const found = messages.find(predicate);
    if (found) return { message: found, messages };
    await sleep(1200);
  }
  throw new Error(`Timed out waiting for KDL Air: ${description}`);
}

async function collectFreshLink(client, peer, item) {
  const seasonText = `S${String(item.season).padStart(2, "0")}`;
  const episodeText = `S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`;
  await client.sendMessage(peer, { message: item.title });

  let state = await waitFor(client, peer,
    message => buttonList(message).some(x => /quality/i.test(x.text)),
    "quality and episode results");

  const qualityOpened = await clickMatching(client, peer, state.messages, /^quality$/i, "Quality");
  if (!qualityOpened) throw new Error("KDL Air did not expose its Quality filter; refusing to guess a stream variant.");

  state = await waitFor(client, peer,
    message => buttonList(message).some(x => new RegExp(`^\\s*${item.quality}\\s*$`, "i").test(x.text)),
    `the ${item.quality} quality option`);
  const qualityChosen = await clickMatching(client, peer, state.messages,
    new RegExp(`^\\s*${item.quality}\\s*$`, "i"), "quality option");
  if (!qualityChosen) throw new Error(`KDL Air did not offer ${item.quality}; no other quality will be substituted.`);

  if (Number(item.season) > 1) {
    state = await waitFor(client, peer,
      message => buttonList(message).some(x => /season/i.test(x.text)),
      "season selector", 12000);
    const seasonOpened = await clickMatching(client, peer, state.messages, /^season$/i, "Season");
    if (!seasonOpened) throw new Error("Season selector unavailable.");
    state = await waitFor(client, peer,
      message => buttonList(message).some(x => new RegExp(`(?:^|\\b)${seasonText}(?:\\b|$)|^\\s*${item.season}\\s*$`, "i").test(x.text)),
      `${seasonText} option`);
    const seasonChosen = await clickMatching(client, peer, state.messages,
      new RegExp(`(?:^|\\b)${seasonText}(?:\\b|$)|^\\s*${item.season}\\s*$`, "i"), "season option");
    if (!seasonChosen) throw new Error(`KDL Air did not offer ${seasonText}.`);
  }

  state = await waitFor(client, peer,
    message => buttonList(message).some(x => new RegExp(episodeText, "i").test(x.text)),
    `${episodeText} episode`);
  const episodeChosen = await clickMatching(client, peer, state.messages, new RegExp(episodeText, "i"), "episode");
  if (!episodeChosen) throw new Error(`KDL Air did not expose ${episodeText} as a selectable button.`);

  state = await waitFor(client, peer,
    message => buttonList(message).some(x => /generate streamlink/i.test(x.text)),
    "Generate Streamlink button");
  const generated = await clickMatching(client, peer, state.messages, /generate streamlink/i, "Generate Streamlink");
  if (!generated) throw new Error("Generate Streamlink button was unavailable.");

  state = await waitFor(client, peer,
    message => /your link\s*:/i.test(String(message.message || "")) &&
      /https:\/\//i.test(String(message.message || "")),
    "generated streamlink", 45000);
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
  for (const item of scan.links || []) {
    const result = await checkLink(item.streamUrl);
    if (result.expired) {
      console.log(`Confirmed expired: ${item.title} S${item.season}E${item.episode} ${item.quality}`);
      expired.push(item);
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
