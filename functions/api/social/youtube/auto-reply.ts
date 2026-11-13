import { Env, json, currentAdmin } from "../../auth/_shared";

type AutoEnv = Env & {
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  YOUTUBE_TOKEN_ENCRYPTION_KEY?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
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
  if (env.GEMINI_API_KEY) {
    const model = env.GEMINI_MODEL || "gemini-2.5-flash";
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.35, maxOutputTokens: 180 } })
    });
    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
    if (response.ok) return (data.candidates?.[0]?.content?.parts || []).map(x => x.text || "").join("").trim();
    if (!env.AI && !env.OPENAI_API_KEY) throw new Error(data.error?.message || "Gemini reply generation failed.");
  }
  if (env.AI) {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { messages: [{ role: "system", content: system }, { role: "user", content: prompt }] });
    return String(result?.response || result?.result?.response || "").trim();
  }
  if (env.OPENAI_API_KEY) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ model: env.OPENAI_MODEL || "gpt-4o-mini", temperature: 0.35, max_tokens: 150, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }) });
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (response.ok) return String(data.choices?.[0]?.message?.content || "").trim();
    throw new Error(data.error?.message || "OpenAI reply generation failed.");
  }
  throw new Error("No AI provider configured. Configure Gemini or Cloudflare Workers AI.");
}

export const onRequestPost: PagesFunction<AutoEnv> = async ({ request, env }) => {
  const admin = await currentAdmin(request, env);
  if (!admin || admin.role !== "owner") return json({ error: "Only the MaseNet owner can run automatic YouTube replies." }, 403);
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS social_comment_drafts (id TEXT PRIMARY KEY, comment_id TEXT NOT NULL UNIQUE, video_id TEXT, video_title TEXT, author TEXT, comment_text TEXT, draft_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), published_at TEXT)").run();
    const channel = await env.DB.prepare("SELECT channel_id FROM social_connections WHERE provider='youtube'").first<{ channel_id: string }>();
    if (!channel?.channel_id) throw new Error("YouTube channel is not connected.");
    const token = await youtubeToken(env);
    const list = await fetch("https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&allThreadsRelatedToChannelId=" + encodeURIComponent(channel.channel_id) + "&maxResults=30&order=time&textFormat=plainText", { headers: { Authorization: "Bearer " + token } });
    const payload = await list.json() as { items?: Array<any>; error?: { message?: string } };
    if (!list.ok) throw new Error(payload.error?.message || "Could not fetch YouTube comments.");
    let published = 0, skipped = 0, failed = 0;
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
      if (existing) { skipped++; continue; }
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
        await env.DB.prepare("INSERT INTO social_comment_drafts(id,comment_id,video_id,video_title,author,comment_text,draft_text,status) VALUES(?,?,?,?,?,?,?,'publishing')").bind(id, commentId, videoId, title, author, text, reply.slice(0, 1000)).run();
        const sent = await fetch("https://www.googleapis.com/youtube/v3/comments?part=snippet", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ snippet: { parentId: commentId, textOriginal: reply.slice(0, 1000) } }) });
        const result = await sent.json() as { id?: string; error?: { message?: string } };
        if (!sent.ok) {
          await env.DB.prepare("UPDATE social_comment_drafts SET status='failed' WHERE comment_id=?").bind(commentId).run();
          failed++;
          continue;
        }
        await env.DB.prepare("UPDATE social_comment_drafts SET status='published',published_at=datetime('now') WHERE comment_id=? AND status='publishing'").bind(commentId).run();
        published++;
      } catch {
        failed++;
      }
    }
    return json({ ok: true, published, skipped, failed, checked: (payload.items || []).length });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Automatic YouTube replies failed." }, 500);
  }
};
