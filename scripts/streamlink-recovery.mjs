import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { matchesKdlFileButton, isNextPageLabel } from "./streamlink-recovery-matchers.mjs";
import { request as httpsRequest } from "node:https";

const required = ["MASETV_RECOVERY_URL", "STREAMLINK_RECOVERY_TOKEN", "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION", "KDL_AIR_BOT_USERNAME"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment secret: ${key}`);
}
const recoveryEndpoint = new URL(process.env.MASETV_RECOVERY_URL);
if (!recoveryEndpoint.pathname.replace(/\/$/, "").endsWith("/api/streamlink-recovery")) {
  recoveryEndpoint.pathname = `${recoveryEndpoint.pathname.replace(/\/$/, "")}/api/streamlink-recovery`;
}
const recoveryUrl = recoveryEndpoint.toString();
const authHeaders = {
  Authorization: `Bearer ${process.env.STREAMLINK_RECOVERY_TOKEN}`,
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

function isPublicIPv4(address){const p=address.split(".").map(Number);if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255))return false;const[a,b,d]=p;if(a===0||a===10||a===127||a>=224)return false;if(a===100&&b>=64&&b<=127)return false;if(a===169&&b===254)return false;if(a===172&&b>=16&&b<=31)return false;if(a===192&&(b===0||b===168))return false;if(a===198&&(b===18||b===19||b===51))return false;if(a===203&&b===0&&d===113)return false;return true;}
function isPublicIPv6(address){const v=address.toLowerCase().split("%")[0];if(v.startsWith("::ffff:")||v==="::"||v==="::1")return false;const first=Number.parseInt(v.split(":")[0]||"0",16);if(!Number.isFinite(first)||first<0x2000||first>0x3fff)return false;if(v.startsWith("2001:db8:")||v.startsWith("2001:10:")||v.startsWith("2002:"))return false;return true;}
async function resolvePublicTarget(url){const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,"");if(!host||host==="localhost"||host.endsWith(".localhost")||host.endsWith(".local")||host.endsWith(".internal"))throw new Error("Blocked non-public media hostname.");if(isIP(host))throw new Error("IP-literal stream URLs are not allowed.");const records=await lookup(host,{all:true,verbatim:true});if(!records.length||records.some(r=>r.family===4?!isPublicIPv4(r.address):r.family===6?!isPublicIPv6(r.address):true))throw new Error("Media hostname resolves to a non-public or mixed address set.");return records[0];}
async function requestPinnedStatus(url,method,headers,target){return new Promise((resolve,reject)=>{const req=httpsRequest({protocol:"https:",hostname:url.hostname,port:443,method,path:url.pathname+url.search,headers:{"User-Agent":"MaseNet-Link-Recovery/1.0",...headers},servername:url.hostname,lookup:(_hostname,options,callback)=>options?.all?callback(null,[target]):callback(null,target.address,target.family)},res=>{const status=res.statusCode||0;res.destroy();resolve(status);});req.setTimeout(9000,()=>req.destroy(new Error("Media probe timed out.")));req.on("error",reject);req.end();});}
async function checkLink(value){try{const url=new URL(value);if(url.protocol!=="https:"||url.username||url.password||(url.port&&url.port!=="443"))return{expired:false,reason:"unsafe-url-inconclusive"};const target=await resolvePublicTarget(url);const head=await requestPinnedStatus(url,"HEAD",{},target);if(![404,410,405,501].includes(head))return{expired:false,reason:head===401||head===403?"access-denied-inconclusive":`http-${head}`};const first=await requestPinnedStatus(url,"GET",{"Range":"bytes=0-0"},target);if(![404,410].includes(first))return{expired:false,reason:`get-http-${first}`};await sleep(2500);const confirm=await requestPinnedStatus(url,"GET",{"Range":"bytes=0-0"},target);return{expired:[404,410].includes(confirm),reason:`confirmed-get-http-${confirm}`};}catch(error){return{expired:false,reason:`probe-inconclusive: ${error.message}`};}}

const buttonList = message => (message?.replyMarkup?.rows || [])
  .flatMap(row => row.buttons || [])
  .map(button => ({ button, text: String(button.text || "").trim() }));

function messageFileNames(message) {
  const attributes = message?.media?.document?.attributes || [];
  return attributes
    .filter(attribute => typeof attribute?.fileName === "string")
    .map(attribute => attribute.fileName);
}

function messageHasFilename(message, filename) {
  const expected = String(filename || "").toLocaleLowerCase("en");
  if (!expected) return false;
  return [String(message?.message || ""), ...messageFileNames(message)]
    .some(value => value.toLocaleLowerCase("en").includes(expected));
}

async function invokeKdlCallback(client, peer, message, button, label) {
  const before = JSON.stringify({
    text: String(message.message || ""),
    buttons: buttonList(message).map(x => x.text)
  });
  try {
    await client.invoke(new Api.messages.GetBotCallbackAnswer({
      peer, msgId: message.id, data: button.data
    }));
    await sleep(1200);
    return true;
  } catch (error) {
    if (!/BOT_RESPONSE_TIMEOUT|TIMEOUT/i.test(String(error?.message || error))) throw error;
    // Some KDL callbacks edit the existing result message without returning
    // a callback answer. Accept that only when Telegram shows an actual state
    // change or a new bot response; otherwise fail closed.
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const latest = await client.getMessages(peer, { limit: 30 });
      const same = latest.find(x => Number(x.id) === Number(message.id));
      const after = same && JSON.stringify({
        text: String(same.message || ""),
        buttons: buttonList(same).map(x => x.text)
      });
      const newReply = latest.some(x => !x.out && Number(x.id) > Number(message.id));
      if ((after && after !== before) || newReply) {
        await sleep(800);
        console.log(`KDL Air ${label} callback confirmed by message update despite callback timeout.`);
        return true;
      }
      await sleep(500);
    }
    throw new Error(`KDL Air did not confirm the ${label} callback: ${String(error?.message || error)}`);
  }
}

async function clickMatching(client, peer, messages, pattern, label, minMessageId = 0) {
  const freshMessages=messages.filter(m=>!m.out&&Number(m.id)>minMessageId).sort((a,b)=>Number(b.id)-Number(a.id));
  for (const message of freshMessages) {
    for (const item of buttonList(message)) {
      if (!pattern.test(item.text)) continue;
      if (!item.button.data) throw new Error(`The ${label} button is not a supported callback button.`);
      return invokeKdlCallback(client, peer, message, item.button, label);
    }
  }
  return false;
}

async function clickButtonOnMessage(client, peer, message, pattern, label) {
  const match = buttonList(message).find(x => typeof pattern === "function" ? pattern(x.text) : pattern.test(x.text));
  if (!match?.button?.data) throw new Error(`The exact ${label} button was not present on its matched message.`);
  return invokeKdlCallback(client, peer, message, match.button, label);
}

function exactEpisodeFileButton(message, item, episodeText) {
  return buttonList(message).find(({text}) =>
    matchesKdlFileButton(text, item, episodeText));
}

async function findAndSelectEpisodeFile(client, peer, item, sentId, episodeText, { qualityConfirmed = false } = {}) {
  const visited = new Set();
  for (let page = 0; page < 30; page++) {
    const messages = await client.getMessages(peer, { limit: 30 });
    const fresh = messages.filter(m => !m.out && Number(m.id) > sentId)
      .sort((a,b) => Number(b.id) - Number(a.id));
    for (const message of fresh) {
      const candidates = buttonList(message).filter(({text}) =>
        matchesKdlFileButton(text, item, episodeText, { qualityConfirmed }) &&
        (!item.language || text.toLowerCase().includes(String(item.language).toLowerCase()))
      );
      if (candidates.length > 1) {
        throw new Error(`KDL Air returned ${candidates.length} indistinguishable files for ${episodeText} after filtering. Refusing to guess a language or release.`);
      }
      const candidate = candidates[0];
      if (candidate?.button?.data) {
        await clickButtonOnMessage(client, peer, message,
          text => text === candidate.text, `${episodeText} ${item.quality} ${item.codec} file`);
        return candidate.text;
      }
    }
    const pageMessage = fresh.find(message =>
      buttonList(message).some(x => isNextPageLabel(x.text)));
    if (!pageMessage) throw new Error(`Could not find ${episodeText} at the current page, and KDL Air exposed no Next button. No other episode was selected.`);
    const pageSignature = `${pageMessage.id}:${pageMessage.message || ""}:${buttonList(pageMessage).map(x=>x.text).join("|")}`;
    if (visited.has(pageSignature)) throw new Error("KDL Air pagination did not advance; stopping safely.");
    visited.add(pageSignature);
    await clickButtonOnMessage(client, peer, pageMessage,
      isNextPageLabel, "Next page");
    await sleep(1100);
  }
  throw new Error("Episode was not found within 30 KDL Air pages; no substitute was selected.");
}

async function waitFor(client, peer, predicate, description, timeoutMs = 25000, minMessageId = 0) {
  const end = Date.now() + timeoutMs;
  const observed = new Set();
  while (Date.now() < end) {
    const messages = await client.getMessages(peer, { limit: 30 });
    const fresh = messages.filter(m => !m.out && Number(m.id) > minMessageId);
    for (const message of fresh) {
      const id = Number(message.id);
      if (observed.has(id)) continue;
      observed.add(id);
      const preview = String(message.message || "").replace(/https?:\/\/[^\s<>]+/gi, "[url]").replace(/\s+/g, " ").slice(0, 140);
      const labels = buttonList(message).map(item => item.text).filter(Boolean).slice(0, 16);
      console.log("KDL Air response:", JSON.stringify({ id, text: preview, buttons: labels }));
    }
    const found = fresh.find(predicate);
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
  // KDL wraps the title in labels such as "Drama" and "Results For".
  // Match the complete normalized title phrase inside that text, not only
  // when the entire Telegram message consists of the title.
  return visible.some(value => (" " + value + " ").includes(" " + expected + " "));
}

async function collectFreshLink(client, peer, item) {
  if (item.kind !== "drama") {
    throw new Error("This verified Telegram workflow is for dramas only. Movie retrieval remains disabled until its KDL Air selection flow is verified.");
  }
  const seasonText = `S${String(item.season).padStart(2, "0")}`;
  const episodeText = `S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`;
  const sent = await client.sendMessage(peer, { message: item.title });
  const sentId = Number(sent?.id || 0);

  // The title result may include the episode list immediately. Quality and
  // Season are filters, not mandatory steps: first try the default result.
  let state = await waitFor(client, peer,
    message => Number(message.id) > sentId &&
      responseMatchesExactTitle(message, item.title),
    `an exact-title result for "${item.title}"`,25000,sentId);

  let selectedFilename;
  try {
    selectedFilename = await findAndSelectEpisodeFile(client, peer, item, sentId, episodeText);
    console.log(`Selected exact default-list variant: ${selectedFilename}`);
  } catch (directError) {
    console.log(`Default episode list did not expose an exact quality/codec match: ${directError.message}`);
    // Use Quality only as a fallback when the unfiltered list cannot identify
    // the saved variant. Never substitute a different quality.
    const latestDefaultResults = await client.getMessages(peer, { limit: 30 });
    const qualityOpened = await clickMatching(client, peer, latestDefaultResults, /^quality$/i, "Quality",sentId);
    if (!qualityOpened) throw new Error(`No exact default-list match and KDL Air has no Quality filter: ${directError.message}`);
    const qualityState = await waitFor(client, peer,
      message => buttonList(message).some(x => new RegExp(`^\\s*${item.quality}\\s*$`, "i").test(x.text)),
      `the ${item.quality} quality option`,25000,sentId);
    const qualityChosen = await clickMatching(client, peer, qualityState.messages,
      new RegExp(`^\\s*${item.quality}\\s*$`, "i"), "quality option",sentId);
    if (!qualityChosen) throw new Error(`KDL Air did not offer ${item.quality}; no other quality will be substituted.`);

    // Season is also a fallback, only used if the filtered episode list does
    // not contain the exact saved episode on its current pages.
    try {
      selectedFilename = await findAndSelectEpisodeFile(client, peer, item, sentId, episodeText, { qualityConfirmed: true });
    } catch (qualityError) {
      const latest = await client.getMessages(peer, { limit: 30 });
      const seasonOpened = await clickMatching(client, peer, latest, /^season$/i, "Season",sentId);
      if (!seasonOpened) throw new Error(`Exact episode not found after Quality filter and no Season filter was available: ${qualityError.message}`);
      const seasonState = await waitFor(client, peer,
        message => buttonList(message).some(x => new RegExp(`(?:^|\\b)${seasonText}(?:\\b|$)|^\\s*${item.season}\\s*$`, "i").test(x.text)),
        `${seasonText} option`,25000,sentId);
      const seasonChosen = await clickMatching(client, peer, seasonState.messages,
        new RegExp(`(?:^|\\b)${seasonText}(?:\\b|$)|^\\s*${item.season}\\s*$`, "i"), "season option",sentId);
      if (!seasonChosen) throw new Error(`KDL Air did not offer ${seasonText}.`);
      selectedFilename = await findAndSelectEpisodeFile(client, peer, item, sentId, episodeText, { qualityConfirmed: true });
    }
  }

  // Generate must belong to the exact file card selected above. Never click a
  // Generate button from a different or merely newer KDL message.
  state = await waitFor(client, peer,
    message => messageHasFilename(message, selectedFilename) &&
      buttonList(message).some(x => /generate streamlink/i.test(x.text)),
    `Generate Streamlink for ${selectedFilename}`,25000,sentId);
  await clickButtonOnMessage(client, peer, state.message, /generate streamlink/i,
    `Generate Streamlink for ${selectedFilename}`);

  const generateMessageId = Number(state.message.id);
  state = await waitFor(client, peer,
    message => Number(message.id) > generateMessageId &&
      /your link\s*:/i.test(String(message.message || "")) &&
      /https:\/\//i.test(String(message.message || "")),
    "a newly generated streamlink for the selected file",45000,generateMessageId);
  const text = String(state.message.message || "");
  const match = text.match(/your link\s*:\s*(https:\/\/[^\s<>]+)/i);
  if (!match) throw new Error("KDL Air response did not contain a readable streamlink.");
  const freshUrl = match[1].replace(/[),.]+$/, "");
  const parsedFreshUrl = new URL(freshUrl);
  if (parsedFreshUrl.protocol !== "https:" || parsedFreshUrl.username || parsedFreshUrl.password ||
      (parsedFreshUrl.port && parsedFreshUrl.port !== "443")) {
    throw new Error("KDL Air returned an unsafe stream URL; replacement was blocked.");
  }
  await resolvePublicTarget(parsedFreshUrl);
  let filename = "";
  try { filename = decodeURIComponent(new URL(freshUrl).pathname.split("/").pop() || ""); } catch {}
  // The exact KDL file-selection button is authoritative for quality and codec.
  // Temporary URLs may use opaque IDs; reject only metadata that contradicts
  // the exact file selected from KDL Air.
  const freshQuality = filename.match(/\b(2160p|1440p|1080p|720p|576p|540p|480p|360p)\b/i)?.[1]?.toLowerCase();
  const freshCodec = filename.match(/\b(x265|h265|hevc|x264|h264|av1)\b/i)?.[1]?.toLowerCase();
  const expectedCodec = String(item.codec || "Unknown").toLowerCase();
  const aliases = { hevc: "x265", h265: "x265", h264: "x264" };
  if (freshQuality && freshQuality !== String(item.quality).toLowerCase()) {
    throw new Error("KDL Air URL filename contradicts the selected quality; replacement was blocked.");
  }
  if (freshCodec && (aliases[freshCodec] || freshCodec) !== (aliases[expectedCodec] || expectedCodec)) {
    throw new Error("KDL Air URL filename contradicts the selected codec; replacement was blocked.");
  }
  return freshUrl;
}

async function main() {
  const tokenParts = process.env.STREAMLINK_RECOVERY_TOKEN.split(".");
  if (tokenParts.length === 3) {
    const claims = JSON.parse(Buffer.from(tokenParts[1], "base64url").toString("utf8"));
    console.log("Recovery OIDC identity:", JSON.stringify({
      iss: claims.iss, aud: claims.aud, repository: claims.repository,
      ref: claims.ref, workflow: claims.workflow, exp: claims.exp
    }));
  }
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

  // Bound each scheduled run so a large backlog cannot flood KDL Air or
  // monopolize the Telegram session. Remaining exact matches are deferred
  // to the next scheduled run.
  const maxRecoveries = Math.max(1, Math.min(5,
    Number.parseInt(process.env.MAX_RECOVERIES_PER_RUN || "2", 10) || 2));
  // First validate against the exact drama title shown in the supplied KDL Air
  // walkthrough. This is only an ordering preference; every episode, season,
  // quality and codec still has to match exactly before a replacement is allowed.
  const knownWalkthroughTitle = "blossom in darkness";
  const recoveryBatch = [...expired].sort((a, b) =>
    Number(String(b.title || "").trim().toLocaleLowerCase("en") === knownWalkthroughTitle) -
    Number(String(a.title || "").trim().toLocaleLowerCase("en") === knownWalkthroughTitle)
  ).slice(0, maxRecoveries);
  if (expired.length > recoveryBatch.length) {
    console.log(`Deferring ${expired.length - recoveryBatch.length} expired variants to later scheduled runs.`);
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
    let failedRecoveries = 0;
    for (const item of recoveryBatch) {
      try {
        const newUrl = await collectFreshLink(client, peer, item);
        const updated = await recoveryApi("replace", {
          titleId: item.titleId, episodeId: item.episodeId, episodeIndex: item.episodeIndex,
          oldUrl: item.streamUrl, newUrl, quality: item.quality, codec: item.codec
        });
        console.log(`Replaced ${updated.title} S${updated.season}E${updated.episode} ${updated.quality} only.`);
      } catch (error) {
        failedRecoveries++;
        console.error(`Recovery failed for ${item.title} ${item.episodeId} ${item.quality}:`, error.message);
      }
      await sleep(1800);
    }
    if (failedRecoveries > 0) {
      throw new Error(`${failedRecoveries} of ${recoveryBatch.length} attempted recoveries failed; no unverified URL was written.`);
    }
  } finally {
    await client.disconnect();
  }
}

main().catch(error => {
  console.error("Streamlink recovery run failed:", error);
  process.exitCode = 1;
});
