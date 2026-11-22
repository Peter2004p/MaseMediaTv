import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { matchesKdlFileButton, isNextPageLabel, isKdlEpisodeRowLabel, matchesReleaseTag } from "./streamlink-recovery-matchers.mjs";
import { request as httpsRequest } from "node:https";

const required = ["MASETV_RECOVERY_URL", "STREAMLINK_RECOVERY_TOKEN", "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION", "KDL_AIR_BOT_USERNAME"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment secret: ${key}`);
}

// Fail closed until the operator has verified that the KDL Air source and the
// specific content may legally be redistributed by MaseNet. This is an
// explicit deployment gate, not a claim that a source is licensed.
const authorizationReference = String(process.env.KDL_AIR_REDISTRIBUTION_AUTHORIZATION_REFERENCE || "").trim();
if (process.env.KDL_AIR_REDISTRIBUTION_AUTHORIZED !== "true" || !authorizationReference) {
  throw new Error("KDL Air recovery is disabled: verify redistribution rights, then configure KDL_AIR_REDISTRIBUTION_AUTHORIZED=true and KDL_AIR_REDISTRIBUTION_AUTHORIZATION_REFERENCE.");
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

async function waitForKdlFilePage(client, peer, sentId, previousSignature = null, timeoutMs = 22000) {
  const end = Date.now() + timeoutMs;
  const backClicked = new Set();
  while (Date.now() < end) {
    const messages = await client.getMessages(peer, { limit: 30 });
    const fresh = messages.filter(message => !message.out && Number(message.id) > sentId)
      .sort((a, b) => Number(b.id) - Number(a.id));
    for (const message of fresh) {
      const buttons = buttonList(message);
      const back = buttons.find(item => /back to files/i.test(item.text));
      if (back?.button?.data && !backClicked.has(Number(message.id))) {
        backClicked.add(Number(message.id));
        await clickButtonOnMessage(client, peer, message,
          /back to files/i, "return to filtered episode files");
        break;
      }
      const hasEpisodeRows = buttons.some(item => isKdlEpisodeRowLabel(item.text));
      const hasNext = buttons.some(item => isNextPageLabel(item.text));
      if (!hasEpisodeRows && !hasNext) continue;
      const signature = `${message.id}:${message.message || ""}:${buttons.map(item => item.text).join("|")}`;
      if (signature !== previousSignature) return { message, signature };
    }
    await sleep(850);
  }
  throw new Error("KDL Air did not finish refreshing the episode file list after the quality or page selection.");
}

async function findAndSelectEpisodeFile(client, peer, item, sentId, episodeText, { qualityConfirmed = false } = {}) {
  const visited = new Set();
  let previousSignature = null;
  for (let page = 0; page < 30; page++) {
    // Telegram edits the same bot message when an inline button is pressed.
    // Wait for that edited keyboard instead of inspecting the stale quality
    // menu or the pre-filter page immediately after the callback returns.
    const current = await waitForKdlFilePage(client, peer, sentId, previousSignature);
    const message = current.message;
    const candidates = buttonList(message).filter(({ text }) =>
      matchesKdlFileButton(text, item, episodeText, { qualityConfirmed }) &&
      matchesReleaseTag(text, item.releaseTag) &&
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
    const next = buttonList(message).some(item => isNextPageLabel(item.text));
    if (!next) {
      throw new Error(`KDL Air reached the end of the available pages without an exact ${episodeText} ${item.quality} ${item.codec} file. No other episode was selected.`);
    }
    if (visited.has(current.signature)) throw new Error("KDL Air pagination repeated the same page; stopping safely.");
    visited.add(current.signature);
    await clickButtonOnMessage(client, peer, message, isNextPageLabel, "Next page");
    previousSignature = current.signature;
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

async function waitForGeneratedLink(client, peer, sourceMessage, timeoutMs = 45000) {
  const sourceId = Number(sourceMessage.id);
  const originalText = String(sourceMessage.message || "");
  const originalButtons = buttonList(sourceMessage).map(item => item.text).join("|");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const messages = await client.getMessages(peer, { limit: 30 });
    const fresh = messages.filter(message => !message.out && Number(message.id) > sourceId);
    const same = messages.find(message => !message.out && Number(message.id) === sourceId);
    const sameChanged = same &&
      (String(same.message || "") !== originalText ||
       buttonList(same).map(item => item.text).join("|") !== originalButtons);
    const candidates = [...fresh, ...(sameChanged ? [same] : [])]
      .sort((a, b) => Number(b.id) - Number(a.id));
    const found = candidates.find(message =>
      /your link\s*:/i.test(String(message.message || "")) &&
      /https:\/\//i.test(String(message.message || "")));
    if (found) return { message: found, messages };
    await sleep(1000);
  }
  throw new Error("KDL Air did not return a generated streamlink as a new reply or an edited file message.");
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
  const episodeText = `S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`;
  // The intended KDL sequence is deliberately simple:
  // search exact drama title -> choose the expired variant's quality ->
  // choose that exact episode/file -> Generate Streamlink.
  const sent = await client.sendMessage(peer, { message: item.title });
  const sentId = Number(sent?.id || 0);
  const titleState = await waitFor(client, peer,
    message => Number(message.id) > sentId &&
      responseMatchesExactTitle(message, item.title) &&
      buttonList(message).some(x => /^quality$/i.test(x.text)),
    `the title result and its Quality button for "${item.title}"`, 25000, sentId);

  await clickButtonOnMessage(client, peer, titleState.message, /^quality$/i, "Quality");
  const qualityMatches = text => String(text).trim().toLowerCase() === String(item.quality).trim().toLowerCase();
  const qualityState = await waitFor(client, peer,
    message => buttonList(message).some(x => qualityMatches(x.text)),
    `the exact ${item.quality} quality option`, 25000, sentId);
  await clickButtonOnMessage(client, peer, qualityState.message, qualityMatches, `${item.quality} quality`);

  // KDL Air may either return directly to the filtered episode list or
  // show a separate "Back to files" control. waitForKdlFilePage handles both
  // layouts; do not require a button that some bot responses never display.
  // Pagination is allowed solely to locate the same episode/variant.
  const selectedFilename = await findAndSelectEpisodeFile(
    client, peer, item, sentId, episodeText, { qualityConfirmed: true }
  );
  console.log(`Selected exact KDL Air file after choosing ${item.quality}: ${selectedFilename}`);

  // KDL's episode-list button is only a size/title label. The selected
  // Telegram document carries the real filename, including its actual quality
  // and codec. Verify that attachment before asking KDL to generate a URL.
  let state = await waitFor(client, peer,
    message => messageFileNames(message).some(name =>
      /S\d{2}E\d{2}/i.test(name) &&
      name.toLowerCase().includes(episodeText.toLowerCase())) &&
      buttonList(message).some(x => /generate streamlink/i.test(x.text)),
    `the selected ${episodeText} file card and Generate Streamlink button`, 25000, sentId);
  const selectedAttachment = messageFileNames(state.message).find(name =>
    name.toLowerCase().includes(episodeText.toLowerCase()));
  if (!selectedAttachment) throw new Error("KDL Air did not attach a verifiable filename for the selected episode.");
  const selectedQuality = selectedAttachment.match(/\b(2160p|1440p|1080p|720p|576p|540p|480p|360p)\b/i)?.[1]?.toLowerCase();
  const selectedCodec = selectedAttachment.match(/\b(x265|h265|hevc|x264|h264|av1)\b/i)?.[1]?.toLowerCase();
  const aliases = { hevc: "x265", h265: "x265", h264: "x264" };
  const expectedCodec = String(item.codec || "Unknown").toLowerCase();
  if (!selectedQuality || selectedQuality !== String(item.quality).toLowerCase()) {
    throw new Error(`Selected KDL attachment quality ${selectedQuality || "unknown"} does not exactly match ${item.quality}; replacement was blocked.`);
  }
  if (!selectedCodec || (aliases[selectedCodec] || selectedCodec) !== (aliases[expectedCodec] || expectedCodec)) {
    throw new Error(`Selected KDL attachment codec ${selectedCodec || "unknown"} does not exactly match ${expectedCodec}; replacement was blocked.`);
  }
  console.log(`Verified selected attachment: ${selectedAttachment}`);
  const generateSourceMessage = state.message;
  await clickButtonOnMessage(client, peer, generateSourceMessage, /generate streamlink/i,
    `Generate Streamlink for ${selectedAttachment}`);

  state = await waitForGeneratedLink(client, peer, generateSourceMessage, 45000);
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
  const freshQuality = filename.match(/\b(2160p|1440p|1080p|720p|576p|540p|480p|360p)\b/i)?.[1]?.toLowerCase();
  const freshCodec = filename.match(/\b(x265|h265|hevc|x264|h264|av1)\b/i)?.[1]?.toLowerCase();
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
      if (result.expired && item.kind === "drama") {
        console.log(`Confirmed expired drama link: ${item.title} S${item.season}E${item.episode} ${item.quality}`);
        expired.push(item);
      } else if (result.expired) {
        // Movie retrieval has no verified KDL selection flow yet. Keep those
        // records untouched and out of the drama recovery batch.
        console.log(`Confirmed expired movie link, skipped safely (movie recovery is not enabled): ${item.title} ${item.quality}`);
      }
    }
  }
  if (!expired.length) {
    console.log("No confirmed expired drama links eligible for this runner. No catalogue changes made.");
    return;
  }

  // Bound each scheduled run so a large backlog cannot flood KDL Air or
  // monopolize the Telegram session. Remaining exact matches are deferred
  // to the next scheduled run.
  // Keep batches small enough to finish comfortably inside the
  // scheduled job timeout while recovering more than one exact variant.
  const maxRecoveries = 2;
  // First validate against the exact drama title shown in the supplied KDL Air
  // walkthrough. This is only an ordering preference; every episode, season,
  // quality and codec still has to match exactly before a replacement is allowed.
  const knownWalkthroughTitle = "blossom in darkness";
  const recoveryScore = item =>
    (String(item.codec || "Unknown").toLowerCase() !== "unknown" ? 2 : 0) +
    (String(item.releaseTag || "").trim() ? 4 : 0);
  const recoveryBatch = [...expired].sort((a, b) =>
    recoveryScore(b) - recoveryScore(a) ||
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
