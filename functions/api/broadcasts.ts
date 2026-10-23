import { Env, json, requireAdmin } from "./auth/_shared";
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rows = await env.DB.prepare("SELECT id,title,description,media_url,target,expires_at,created_at FROM broadcasts WHERE expires_at IS NULL OR expires_at > datetime('now') ORDER BY created_at DESC").all<Record<string,unknown>>();
  const posts = (rows.results || []).map(r => { const raw=String(r.description||""); const marker="[[MASETNET_HEADING]]"; const split=raw.indexOf(marker); const heading=split>=0?raw.slice(split+marker.length,raw.indexOf("\\n",split)>=0?raw.indexOf("\\n",split):undefined):String(r.title||""); const description=split>=0?raw.slice(raw.indexOf("\\n",split)+1):raw; return ({ id:r.id, title:r.title, heading, description, mediaType: String(r.media_url||"").match(/\.(mp4|webm|mov)(\?|$)/i) ? "video" : String(r.media_url||"").match(/\.gif(\?|$)/i) ? "gif" : "image", mediaUrl:r.media_url, caption:r.description, destination:r.target, expiresAt:r.expires_at, createdAt:r.created_at }); });
  return json({ posts });
};
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const gate = await requireAdmin(request, env); if (gate.response) return gate.response;
  const body = await request.json() as Record<string,unknown>;
  const id = crypto.randomUUID(), title = typeof body.title === "string" ? body.title.trim() : "";
  const plainDescription = typeof body.caption === "string" ? body.caption : typeof body.description === "string" ? body.description : ""; const heading = typeof body.heading === "string" ? body.heading.trim() : ""; const description = heading ? "[[MASETNET_HEADING]]"+heading+"\\n"+plainDescription : plainDescription;
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
  return json({ post:{id,title,heading,description:plainDescription,mediaType:body.mediaType === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(mediaUrl) ? "video" : body.mediaType === "gif" || /\.gif(\?|$)/i.test(mediaUrl) ? "gif" : "image",mediaUrl,caption:description,destination:target,expiresAt,createdAt:new Date().toISOString()} , telegram },201);
};
