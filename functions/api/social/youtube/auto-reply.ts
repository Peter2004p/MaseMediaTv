import { Env, json, currentAdmin } from "../../auth/_shared";

type AutoEnv = Env & {
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  YOUTUBE_TOKEN_ENCRYPTION_KEY?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  AI?: { run: (model: string, input: unknown) => Promise<any> };
};

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).map(x => x.toString(16).padStart(2, "0")).join("");
}

async function youtubeToken(env: AutoEnv): Promise<string> {
  const row = await env.DB.prepare("SELECT encrypted_refresh_token FROM social_connections WHERE provider='youtube'").first<{ encrypted_refresh_token: string }>();
  if (!row?.encrypted_refresh_token) throw new Error("YouTube channel is not connected.");
  const raw = Uint8Array.from(atob(env.YOUTUBE_TOKEN_ENCRYPTION_KEY || ""), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("YouTube token encryption key is missing or invalid.");
  const packed = Uint8Array.from(atob(row.encrypted_refresh_token), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw.slice().buffer as ArrayBuffer, "AES-GCM", false, ["decrypt"]);
  const refresh = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12).slice().buffer as ArrayBuffer }, key, packed.slice(12).slice().buffer as ArrayBuffer));
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.YOUTUBE_CLIENT_ID || "", client_secret: env.YOUTUBE_CLIENT_SECRET || "", refresh_token: refresh, grant_type: "refresh_token" })
  });
  const data = await response.json() as { access_token?: string; error_description?: string };
  if (!response.ok || !data.access_token) throw new Error(data.error_description || "Google could not refresh the YouTube access token.");
  return data.access_token;
}

async function makeReply(env: AutoEnv, comment: string, author: string, videoTitle: string): Promise<string> {
  const system = "You are the official MaseMedia TV YouTube community manager. Reply automatically to viewer comments in a friendly, concise, natural, respectful way. Do not invent facts, titles, availability, links, dates, release schedules, support contacts, or promises. Never request personal information or reveal private data. Do not argue, insult, spam, or use excessive emojis. If the comment asks for information you cannot verify, say you will pass the question to the team. If it is abusive, threatening, spam, or contains personal information, return exactly SKIP. Keep replies under 350 characters. Return only the reply or SKIP.";
  const prompt = "Video: " + videoTitle.slice(0, 180) + "\nViewer: " + author.slice(0, 100) + "\nComment: " + comment.slice(0, 2500);
  const errors: string[] = [];
  if (env.GEMINI_API_KEY) {
    try {
      const model = env.GEMINI_MODEL || "gemini-2.5-flash";
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.35, maxOutputTokens: 180 } })
      });
      const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
      const answer = (data.candidates?.[0]?.content?.parts || []).map(x => x.text || "").join("").trim();
      if (response.ok && answer) return answer;
      errors.push(data.error?.message || (response.ok ? "Gemini returned an empty reply." : "Gemini HTTP " + response.status));
    } catch (error) { errors.push(error instanceof Error ? error.message : "Gemini request failed."); }
  }
  if (env.AI) {
    try {
      const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { messages: [{ role: "system", content: system }, { role: "user", content: prompt }] });
      const answer = String(result?.response || result?.result?.response || "").trim();
      if (answer) return answer;
      errors.push("Cloudflare Workers AI returned an empty reply.");
    } catch (error) { errors.push(error instanceof Error ? error.message : "Cloudflare Workers AI failed."); }
  }
  if (env.OPENAI_API_KEY) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ model: env.OPENAI_MODEL || "gpt-4o-mini", temperature: 0.35, max_tokens: 150, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }) });
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      const answer = String(data.choices?.[0]?.message?.content || "").trim();
      if (response.ok && answer) return answer;
      errors.push(data.error?.message || (response.ok ? "OpenAI returned an empty reply." : "OpenAI HTTP " + response.status));
    } catch (error) { errors.push(error instanceof Error ? error.message : "OpenAI request failed."); }
  }
  if (env.GROQ_API_KEY) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.GROQ_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env.GROQ_MODEL || "openai/gpt-oss-20b",
          temperature: 0.35,
          max_tokens: 150,
          messages: [{ role: "system", content: system }, { role: "user", content: prompt }]
        })
      });
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      const answer = String(data.choices?.[0]?.message?.content || "").trim();
      if (response.ok && answer) return answer;
      errors.push(data.error?.message || (response.ok ? "Groq returned an empty reply." : "Groq HTTP " + response.status));
    } catch (error) { errors.push(error instanceof Error ? error.message : "Groq request failed."); }
  }
  throw new Error(errors.join(" | ") || "No AI provider configured. configure at least one AI provider.");
}

export const onRequestPost: PagesFunction<AutoEnv> = async ({ request, env }) => {
  try {
    const admin = await currentAdmin(request, env);
    let schedulerAuthorized = false;
    const schedulerSecret = request.headers.get("x-masenet-auto-reply") || "";
    if (schedulerSecret) {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS social_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
      const expected = await env.DB.prepare("SELECT setting_value FROM social_settings WHERE setting_key='youtube_auto_reply_secret_sha256'").first<{ setting_value: string }>();
      if (expected?.setting_value) {
        const supplied = await sha256(schedulerSecret);
        if (supplied.length === expected.setting_value.length) {
          let diff = 0;
          for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ expected.setting_value.charCodeAt(i);
          schedulerAuthorized = diff === 0;
        }
      }
    }
    if ((!admin || admin.role !== "owner") && !schedulerAuthorized) return json({ error: "Only the MaseNet owner or authorised scheduler can run automatic YouTube replies." }, 403);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS social_comment_drafts (id TEXT PRIMARY KEY, comment_id TEXT NOT NULL UNIQUE, video_id TEXT, video_title TEXT, author TEXT, comment_text TEXT, draft_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), published_at TEXT, last_error TEXT)").run();
    const draftColumns = await env.DB.prepare("PRAGMA table_info(social_comment_drafts)").all<{ name: string }>();
    if (!(draftColumns.results || []).some(column => column.name === "last_error")) {
      await env.DB.prepare("ALTER TABLE social_comment_drafts ADD COLUMN last_error TEXT").run();
    }
    const channel = await env.DB.prepare("SELECT channel_id FROM social_connections WHERE provider='youtube'").first<{ channel_id: string }>();
    if (!channel?.channel_id) throw new Error("YouTube channel is not connected.");
    const token = await youtubeToken(env);
    const list = await fetch("https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&allThreadsRelatedToChannelId=" + encodeURIComponent(channel.channel_id) + "&maxResults=30&order=time&textFormat=plainText", { headers: { Authorization: "Bearer " + token } });
    const payload = await list.json() as { items?: Array<any>; error?: { message?: string } };
    if (!list.ok) throw new Error(payload.error?.message || "Could not fetch YouTube comments.");
    let published = 0, skipped = 0, failed = 0;
    const failureDetails: Array<{ commentId: string; stage: string; reason: string }> = [];
    for (const item of payload.items || []) {
      if (published >= 8) break;
      const snippet = item.snippet || {};
      const top = snippet.topLevelComment || {};
      const comment = top.snippet || {};
      const commentId = String(top.id || "");
      const text = String(comment.textOriginal || comment.textDisplay || "").trim();
      const author = String(comment.authorDisplayName || "Viewer");
      const authorChannel = String(comment.authorChannelId?.value || "");
      if (!commentId || !text || text.length < 2 || snippet.totalReplyCount > 0 || authorChannel === channel.channel_id) { skipped++; continue; }
      const existing = await env.DB.prepare("SELECT status FROM social_comment_drafts WHERE comment_id=?").bind(commentId).first<{ status: string }>();
      if (existing && existing.status !== "failed") { skipped++; continue; }
      // A failed insert is retried only while YouTube still reports no replies.
      // This avoids posting a duplicate when the previous insert succeeded but its response was lost.
      const videoId = String(snippet.videoId || "");
      let title = "YouTube video";
      if (videoId) {
        try {
          const v = await fetch("https://www.googleapis.com/youtube/v3/videos?part=snippet&id=" + encodeURIComponent(videoId), { headers: { Authorization: "Bearer " + token } });
          const vd = await v.json() as { items?: Array<{ snippet?: { title?: string } }> };
          title = vd.items?.[0]?.snippet?.title || title;
        } catch { /* video title is optional */ }
      }
      try {
        const reply = await makeReply(env, text, author, title);
        if (!reply || /^SKIP$/i.test(reply.trim())) { skipped++; continue; }
        const id = crypto.randomUUID();
        if (existing?.status === "failed") {
          await env.DB.prepare("UPDATE social_comment_drafts SET video_id=?,video_title=?,author=?,comment_text=?,draft_text=?,status='publishing',last_error=NULL WHERE comment_id=? AND status='failed'").bind(videoId, title, author, text, reply.slice(0, 1000), commentId).run();
        } else {
          await env.DB.prepare("INSERT INTO social_comment_drafts(id,comment_id,video_id,video_title,author,comment_text,draft_text,status) VALUES(?,?,?,?,?,?,?,'publishing')").bind(id, commentId, videoId, title, author, text, reply.slice(0, 1000)).run();
        }
        const sent = await fetch("https://www.googleapis.com/youtube/v3/comments?part=snippet", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ snippet: { parentId: commentId, textOriginal: reply.slice(0, 1000) } }) });
        const result = await sent.json() as { id?: string; error?: { message?: string } };
        if (!sent.ok) {
          const reason = result.error?.message || ("YouTube API returned HTTP " + sent.status);
          await env.DB.prepare("UPDATE social_comment_drafts SET status='failed',last_error=? WHERE comment_id=?").bind(reason.slice(0, 1000), commentId).run();
          failureDetails.push({ commentId, stage: "youtube_publish", reason: reason.slice(0, 300) });
          failed++;
          continue;
        }
        await env.DB.prepare("UPDATE social_comment_drafts SET status='published',published_at=datetime('now'),last_error=NULL WHERE comment_id=? AND status='publishing'").bind(commentId).run();
        published++;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown processing error";
        const safeReason = reason.slice(0, 1000);
        const prior = await env.DB.prepare("SELECT id FROM social_comment_drafts WHERE comment_id=?").bind(commentId).first<{ id: string }>().catch(() => null);
        if (prior) {
          await env.DB.prepare("UPDATE social_comment_drafts SET status='failed',last_error=? WHERE comment_id=?").bind(safeReason, commentId).run().catch(() => undefined);
        } else {
          await env.DB.prepare("INSERT INTO social_comment_drafts(id,comment_id,video_id,video_title,author,comment_text,draft_text,status,last_error) VALUES(?,?,?,?,?,?,?,'failed',?)").bind(crypto.randomUUID(), commentId, videoId, title, author, text, "[Reply generation failed]", safeReason).run().catch(() => undefined);
        }
        failureDetails.push({ commentId, stage: "reply_processing", reason: safeReason.slice(0, 300) });
        failed++;
      }
    }
    return json({ ok: failed === 0, published, skipped, failed, checked: (payload.items || []).length, failureDetails });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Automatic YouTube replies failed." }, 500);
  }
};
