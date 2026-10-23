import { Env, json, requireAdmin } from "./auth/_shared";
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rows = await env.DB.prepare("SELECT id,title,description,media_url,target,expires_at,created_at FROM broadcasts ORDER BY created_at DESC").all<Record<string,unknown>>();
  const posts = (rows.results || []).map(r => {
    const raw=String(r.description||""); let meta:Record<string,unknown>={}; let description=raw; let heading=String(r.title||"");
    const metaMarker="[[MASETNET_BROADCAST_META]]";
    if(raw.startsWith(metaMarker)){const split=raw.indexOf("\\n");try{meta=JSON.parse(raw.slice(metaMarker.length,split>=0?split:undefined)) as Record<string,unknown>}catch{} description=split>=0?raw.slice(split+2):""; heading=String(meta.heading||heading);}
    else {const marker="[[MASETNET_HEADING]]";const split=raw.indexOf(marker);if(split>=0){const rest=raw.slice(split+marker.length);const divider=rest.indexOf("\\\\n");heading=divider>=0?rest.slice(0,divider):rest;description=divider>=0?rest.slice(divider+3):"";}}
    const mediaUrl=String(r.media_url||"");
    return {id:r.id,title:r.title,heading,description,caption:description,mediaType:(meta.mediaType as string)||(/\.(mp4|webm|mov)(\?|$)/i.test(mediaUrl)?"video":/\.gif(\?|$)/i.test(mediaUrl)?"gif":"image"),mediaUrl,destination:r.target,expiresAt:r.expires_at,createdAt:r.created_at,billboardStyle:meta.billboardStyle,billboardTheme:meta.billboardTheme,billboardSize:meta.billboardSize,billboardShape:meta.billboardShape,billboardAnimation:meta.billboardAnimation,buttonLabel:meta.buttonLabel,buttonUrl:meta.buttonUrl,bubbleMessage:meta.bubbleMessage};
  });
  return json({ posts });
};
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const body = await request.json() as Record<string,unknown>;
  const id = crypto.randomUUID(), title = typeof body.title === "string" ? body.title.trim() : "";
  const plainDescription = typeof body.caption === "string" ? body.caption : typeof body.description === "string" ? body.description : "";
  const heading = typeof body.heading === "string" ? body.heading.trim() : "";
  const metadata = {heading,mediaType:body.mediaType,billboardStyle:body.billboardStyle,billboardTheme:body.billboardTheme,billboardSize:body.billboardSize,billboardShape:body.billboardShape,billboardAnimation:body.billboardAnimation,buttonLabel:body.buttonLabel,buttonUrl:body.buttonUrl,bubbleMessage:body.bubbleMessage};
  const description = "[[MASETNET_BROADCAST_META]]"+JSON.stringify(metadata)+"\\n"+plainDescription;
  const mediaUrl = typeof body.mediaUrl === "string" ? body.mediaUrl : "";
  const target = ["website","telegram","both"].includes(String(body.destination)) ? String(body.destination) : "website";
  const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : null;
  if (!mediaUrl || !/^https:\/\//i.test(mediaUrl)) return json({ error: "A valid HTTPS media URL is required." }, 400);
  await env.DB.prepare("INSERT INTO broadcasts (id,title,description,media_url,target,expires_at) VALUES (?,?,?,?,?,?)").bind(id,title,description,mediaUrl,target,expiresAt).run();
  const telegram = { attempted: target !== "website", delivered: 0, failed: 0 };
  const config = env as Env & { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_MINI_APP_URL?: string; TELEGRAM_WEBAPP_URL?: string };
  if (telegram.attempted) {
    if (!config.TELEGRAM_BOT_TOKEN) telegram.failed = 2;
    else {
      const appUrl = (config.TELEGRAM_MINI_APP_URL || config.TELEGRAM_WEBAPP_URL || "").trim();
      const message = [heading || title, plainDescription, mediaUrl, appUrl.startsWith("https://") ? "Open MaseNet: " + appUrl : ""].filter(Boolean).join("\n\n").slice(0, 3900);
      const mediaType = body.mediaType === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(mediaUrl)
        ? "video"
        : body.mediaType === "gif" || /\.gif(\?|$)/i.test(mediaUrl)
          ? "animation"
          : "photo";
      for (const chatId of ["@MaseMediaTv", "@MoonDramaC"]) {
        try {
          const mediaMethod = mediaType === "video" ? "sendVideo" : mediaType === "animation" ? "sendAnimation" : "sendPhoto";
          const mediaField = mediaType === "video" ? "video" : mediaType === "animation" ? "animation" : "photo";
          const caption = [heading || title, plainDescription, appUrl.startsWith("https://") ? "Open MaseNet: " + appUrl : ""].filter(Boolean).join("\n\n").slice(0, 1000);
          const mediaResponse = await fetch("https://api.telegram.org/bot" + config.TELEGRAM_BOT_TOKEN + "/" + mediaMethod, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, [mediaField]: mediaUrl, caption, disable_notification: false })
          });
          if (mediaResponse.ok) {
            telegram.delivered++;
          } else {
            // Some hosts reject direct URL ingestion; preserve the announcement with a clickable URL.
            const sent = await fetch("https://api.telegram.org/bot" + config.TELEGRAM_BOT_TOKEN + "/sendMessage", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: false })
            });
            if (sent.ok) telegram.delivered++; else telegram.failed++;
          }
        } catch {
          try {
            const sent = await fetch("https://api.telegram.org/bot" + config.TELEGRAM_BOT_TOKEN + "/sendMessage", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: false })
            });
            if (sent.ok) telegram.delivered++; else telegram.failed++;
          } catch { telegram.failed++; }
        }
      }
    }
  }
  return json({ post:{id,title,heading,description:plainDescription,mediaType:body.mediaType === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(mediaUrl) ? "video" : body.mediaType === "gif" || /\.gif(\?|$)/i.test(mediaUrl) ? "gif" : "image",mediaUrl,caption:plainDescription,destination:target,expiresAt,createdAt:new Date().toISOString(),billboardStyle:metadata.billboardStyle,billboardTheme:metadata.billboardTheme,billboardSize:metadata.billboardSize,billboardShape:metadata.billboardShape,billboardAnimation:metadata.billboardAnimation,buttonLabel:metadata.buttonLabel,buttonUrl:metadata.buttonUrl,bubbleMessage:metadata.bubbleMessage} , telegram },201);
};
