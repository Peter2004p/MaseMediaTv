interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  ADMIN_TELEGRAM_CHAT_ID?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  GEMINI_API_KEY?: string;
}
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function hmac(key: BufferSource, data: string) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)));
}
const hex = (value: Uint8Array) => [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");

export const onRequestPost = async ({ request, env, waitUntil }: { request: Request; env: Env; waitUntil: (promise: Promise<unknown>) => void }) => {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Telegram verification is not configured." }, 503);
  const adminId = String(env.ADMIN_TELEGRAM_CHAT_ID || "").trim();
  if (!adminId) return json({ error: "Admin screenshot review is not configured. Set ADMIN_TELEGRAM_CHAT_ID in Cloudflare Pages production variables." }, 503);

  const body = await request.json().catch(() => ({})) as { initData?: string; imageDataUrl?: string };
  const initData = String(body.initData || "");
  if (!initData || initData.length > 8192) return json({ error: "Open MaseNet again from Telegram and retry." }, 401);
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  params.delete("hash");
  const authDate = Number(params.get("auth_date") || 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!hash || !Number.isSafeInteger(authDate) || authDate <= 0 || authDate > nowSeconds + 60 || nowSeconds - authDate > 86400) {
    return json({ error: "Open MaseNet again from Telegram and retry." }, 401);
  }
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  const checkString = entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), env.TELEGRAM_BOT_TOKEN);
  const expected = hex(await hmac(secret, checkString));
  if (expected.length !== hash.length) return json({ error: "Telegram session validation failed." }, 401);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ hash.charCodeAt(i);
  if (mismatch !== 0) return json({ error: "Telegram session validation failed." }, 401);

  let user: { id?: number | string; first_name?: string; last_name?: string; username?: string } | null = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch {}
  if (!user?.id) return json({ error: "Telegram user was not found." }, 401);

  const image = String(body.imageDataUrl || "");
  const match = image.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match || image.length > 14000000) return json({ error: "Choose a valid PNG, JPG or WEBP screenshot under 10 MB." }, 400);
  const mime = match[1];
  const binary = atob(match[2]);
  if (binary.length > 10 * 1024 * 1024) return json({ error: "The screenshot must be smaller than 10 MB." }, 400);

  const chatId = String(user.id);

  // Consume each signed Telegram initData hash once for screenshot submissions.
  // The unique primary key makes concurrent duplicate requests race-safe in D1.
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_verification_replays (
      init_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
    await env.DB.prepare("DELETE FROM telegram_verification_replays WHERE datetime(expires_at) <= datetime('now')").run();
    const replayExpiry = new Date((authDate + 86400) * 1000).toISOString();
    await env.DB.prepare("INSERT INTO telegram_verification_replays (init_hash,expires_at) VALUES (?,?)")
      .bind(hash, replayExpiry).run();
  } catch (error) {
    console.error("MaseNet Telegram verification replay rejected:", error instanceof Error ? error.message : String(error));
    return json({ error: "This Telegram session has already been used for a verification submission. Reopen MaseNet in Telegram and try again." }, 409);
  }
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "Telegram user";
  const username = user.username ? "@" + user.username : "Not provided";
  const submittedAt = new Date().toISOString();
  const submissionId = crypto.randomUUID();

  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_access_verification (
      chat_id TEXT PRIMARY KEY, youtube_ok INTEGER NOT NULL DEFAULT 0,
      youtube_provisional INTEGER NOT NULL DEFAULT 0,
      masemedia_ok INTEGER NOT NULL DEFAULT 0, moondramac_ok INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
    try { await env.DB.prepare("ALTER TABLE telegram_access_verification ADD COLUMN youtube_provisional INTEGER NOT NULL DEFAULT 0").run(); } catch { /* Column already exists. */ }
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_access_submissions (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, display_name TEXT NOT NULL,
      username TEXT, status TEXT NOT NULL DEFAULT 'pending',
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT, ai_verdict TEXT, ai_reason TEXT, ai_reviewed_at TEXT
    )`).run();
    try { await env.DB.prepare("ALTER TABLE telegram_access_submissions ADD COLUMN ai_verdict TEXT").run(); } catch { /* Column already exists. */ }
    try { await env.DB.prepare("ALTER TABLE telegram_access_submissions ADD COLUMN ai_reason TEXT").run(); } catch { /* Column already exists. */ }
    try { await env.DB.prepare("ALTER TABLE telegram_access_submissions ADD COLUMN ai_reviewed_at TEXT").run(); } catch { /* Column already exists. */ }
    await env.DB.prepare(
      "INSERT INTO telegram_access_verification (chat_id,youtube_ok,updated_at) VALUES (?,0,datetime('now')) ON CONFLICT(chat_id) DO NOTHING"
    ).bind(chatId).run();
    const recent = await env.DB.prepare(
      "SELECT id FROM telegram_access_submissions WHERE chat_id=? AND datetime(submitted_at)>=datetime('now','-60 seconds') AND status IN ('pending','ai_review_required','approved_timeout') ORDER BY submitted_at DESC LIMIT 1"
    ).bind(chatId).first<{id:string}>();
    if (recent) return json({ error: "Your recent screenshot is already being processed. Please wait a moment before submitting another." }, 429);
    await env.DB.prepare(
      "INSERT INTO telegram_access_submissions (id,chat_id,display_name,username,status,submitted_at) VALUES (?,?,?,?, 'pending', ?)"
    ).bind(submissionId, chatId, fullName, user.username || null, submittedAt).run();
  } catch (error) {
    console.error("MaseNet screenshot submission could not be saved:", error instanceof Error ? error.message : String(error));
    return json({ error: "We could not save your submission. Please try again." }, 503);
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const form = new FormData();
  form.append("chat_id", adminId);
  form.append("photo", new Blob([bytes.buffer as ArrayBuffer], { type: mime }), "masenet-youtube-subscription." + (mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"));
  form.append("caption", [
    "🛡️ MASENET — YOUTUBE SUBSCRIPTION REVIEW",
    "",
    "👤 Applicant: " + fullName,
    "🔖 Telegram: " + username,
    "🆔 Telegram user ID: " + chatId,
    "🕒 Submitted: " + submittedAt,
    "",
    "REVIEW WINDOW: 5 seconds. If you do not act, provisional access is granted automatically. This does not genuinely verify a YouTube subscription.",
    "",
    "The separate admin action message contains the approval buttons.",
    "✅ Approve = manually confirm this screenshot",
    "❌ Reject = decline this screenshot",
    "⚠️ Flag = start a 24-hour re-verification warning."
  ].join("\n"));
  let adminMessageId: number | null = null;
  try {
    const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendPhoto", { method: "POST", body: form });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; description?: string; result?: { message_id?: number } };
    if (!response.ok || !result.ok) {
      await env.DB.prepare("UPDATE telegram_access_submissions SET status='delivery_failed' WHERE id=?").bind(submissionId).run();
      console.error("MaseNet admin screenshot delivery failed:", response.status, result.description || "Unknown Telegram error");
      return json({ error: "Telegram could not deliver your screenshot to the admin. Please try again shortly." }, 502);
    }
    adminMessageId = Number(result.result?.message_id || 0) || null;

    // Send the review controls as a separate plain-text Telegram message.
    // This avoids Telegram clients silently omitting inline keyboards on photo captions.
    const controls = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: adminId,
        text: [
          "🛡️ MASENET — ADMIN REVIEW ACTIONS",
          "Applicant: " + fullName,
          "Telegram: " + username,
          "Telegram user ID: " + chatId,
          "Submission ID: " + submissionId,
          "",
          "Choose an action within 5 seconds. If you do not act, provisional access is granted automatically. This is never genuine verification. You can still manually approve, reject or flag afterward."
        ].join("\n"),
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Approve", callback_data: "ytapprove:" + submissionId },
            { text: "❌ Reject", callback_data: "ytreject:" + submissionId }
          ], [
            { text: "⚠️ Flag / 24h restriction", callback_data: "ytflag:" + submissionId }
          ]]
        }
      })
    });
    const controlsResult = await controls.json().catch(() => ({})) as { ok?: boolean; description?: string };
    if (!controls.ok || !controlsResult.ok) {
      await env.DB.prepare("UPDATE telegram_access_submissions SET status='delivery_failed' WHERE id=? AND status='pending'").bind(submissionId).run().catch(() => undefined);
      console.error("MaseNet admin review buttons delivery failed:", controls.status, controlsResult.description || "Unknown Telegram error");
      return json({ error: "Your screenshot reached the admin, but the review buttons could not be delivered. Reopen MaseNet from Telegram and submit again." }, 502);
    }
  } catch (error) {
    await env.DB.prepare("UPDATE telegram_access_submissions SET status='delivery_failed' WHERE id=?").bind(submissionId).run().catch(() => undefined);
    console.error("MaseNet admin screenshot delivery error:", error instanceof Error ? error.message : String(error));
    return json({ error: "Could not contact the admin review chat. Please try again shortly." }, 502);
  }


  // Five-second manual window, followed by an AI visual plausibility screen.
  // A positive AI result grants provisional access only; it never proves a real subscription.
  // The database compare-and-set ensures a manual admin action always wins a race.
  waitUntil((async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const current = await env.DB.prepare(
        "SELECT status FROM telegram_access_submissions WHERE id=?"
      ).bind(submissionId).first<{status:string}>();
      if (!current || current.status !== "pending") return;

      // The five-second deadline is the access decision. Grant provisional access
      // immediately, without ever marking the YouTube subscription as genuinely verified.
      // AI screening below is advisory only; the admin can still approve, reject or flag.
      const timeoutGrant = await env.DB.prepare(
        "UPDATE telegram_access_submissions SET status='approved_timeout',reviewed_at=datetime('now') WHERE id=? AND status='pending'"
      ).bind(submissionId).run();
      if (!Number(timeoutGrant.meta?.changes || 0)) return;
      await env.DB.prepare(
        "UPDATE telegram_access_verification SET youtube_ok=0,youtube_provisional=1,updated_at=datetime('now') WHERE chat_id=?"
      ).bind(chatId).run();

      let verdict: "likely_match" | "mismatch" | "unclear" = "unclear";
      let reason = "AI could not confidently assess the screenshot; admin review is still required.";
      let aiAvailable = false;
      const screeningInstructions = [
        "You are a cautious visual screening assistant for a YouTube subscription screenshot.",
        "You cannot access YouTube accounts, verify subscriptions on the server, detect every edited image, or prove that a screenshot is genuine.",
        "Return exactly one JSON object with keys verdict and reason. verdict must be likely_match, mismatch, or unclear.",
        "Use likely_match ONLY when the screenshot clearly shows the YouTube channel MaseMedia TV or exact handle @masemedia_tv AND a visible subscribed state such as Subscribed.",
        "Use mismatch when the screenshot clearly shows a different channel or a visible Subscribe button.",
        "Use unclear for cropped, blurry, obscured, ambiguous, edited-looking, or inconclusive evidence. Never infer hidden details.",
        "Keep reason under 160 characters. Never claim genuine YouTube verification."
      ].join("\\n");
      const parseVerdict = (raw: string) => {
        const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        const parsed = JSON.parse(cleaned) as { verdict?: string; reason?: string };
        if (!["likely_match", "mismatch", "unclear"].includes(String(parsed.verdict))) throw new Error("AI returned an invalid screening verdict");
        verdict = parsed.verdict as typeof verdict;
        reason = String(parsed.reason || reason).slice(0, 160);
        aiAvailable = true;
      };

      // Primary vision screening provider.
      if (env.OPENAI_API_KEY) {
        try {
          const aiResponse = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: env.OPENAI_MODEL || "gpt-6-astra",
              instructions: screeningInstructions,
              input: [{ role: "user", content: [
                { type: "input_text", text: "Assess this screenshot. This is only visual plausibility screening, not genuine YouTube verification." },
                { type: "input_image", image_url: image }
              ] }],
              max_output_tokens: 160
            }),
            signal: AbortSignal.timeout(10000)
          });
          if (!aiResponse.ok) throw new Error("OpenAI visual screening HTTP " + aiResponse.status);
          const aiData = await aiResponse.json() as { output_text?: string; output?: Array<{content?:Array<{type?:string;text?:string}>}> };
          const raw = (aiData.output_text || (aiData.output || []).flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text || "").join("\\n")).trim();
          if (!raw) throw new Error("OpenAI returned an empty visual screening result");
          parseVerdict(raw);
        } catch (error) {
          console.error("MaseNet OpenAI screenshot screening failed; trying Gemini fallback:", error instanceof Error ? error.message : String(error));
        }
      }

      // Gemini is a real fallback, not a silent approval. It runs when OpenAI is
      // unavailable, misconfigured, rate-limited, or returns an unusable response.
      if (!aiAvailable && env.GEMINI_API_KEY) {
        try {
          const geminiResponse = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [
                  { text: screeningInstructions + "\\nAssess the attached screenshot and return only the JSON object." },
                  { inline_data: { mime_type: mime, data: match[2] } }
                ] }],
                generationConfig: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: 160 }
              }),
              signal: AbortSignal.timeout(10000)
            }
          );
          if (!geminiResponse.ok) throw new Error("Gemini visual screening HTTP " + geminiResponse.status);
          const geminiData = await geminiResponse.json() as { candidates?: Array<{content?:{parts?:Array<{text?:string}>}}> };
          const raw = (geminiData.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("\\n").trim();
          if (!raw) throw new Error("Gemini returned an empty visual screening result");
          parseVerdict(raw);
        } catch (error) {
          console.error("MaseNet Gemini screenshot screening failed:", error instanceof Error ? error.message : String(error));
        }
      }

      if (!aiAvailable) {
        console.error("MaseNet automatic screenshot screening unavailable: configure a working OPENAI_API_KEY or GEMINI_API_KEY.");
      }

      // Timeout access is provisional regardless of AI certainty or provider uptime.
      // The AI result is recorded for the admin; it never changes youtube_ok or revokes
      // the five-second provisional grant by itself.
      const aiLabel = aiAvailable
        ? "AI SCREENING: " + String(verdict).toUpperCase() + " — PROVISIONAL ACCESS ONLY; ADMIN REVIEW REQUIRED"
        : "AI SCREENING UNAVAILABLE — PROVISIONAL ACCESS ONLY; ADMIN REVIEW REQUIRED";
      await env.DB.prepare(
        "UPDATE telegram_access_submissions SET ai_verdict=?,ai_reason=?,ai_reviewed_at=datetime('now') WHERE id=? AND status='approved_timeout'"
      ).bind(aiAvailable ? verdict : "review_required", reason, submissionId).run();

      // Access was granted provisionally at the five-second deadline. Do not
      // rewrite access here: an admin may have approved/rejected/flagged while
      // the slower AI screening was running. The admin decision must win.

      if (adminMessageId) {
        const caption = [
          "🛡️ MASENET — YOUTUBE SUBSCRIPTION REVIEW",
          "",
          "Applicant: " + fullName,
          "Telegram: " + username,
          "Telegram ID: " + chatId,
          "Submitted: " + submittedAt,
          "",
          aiLabel,
          "AI note: " + reason,
          "IMPORTANT: AI only checks visible screenshot plausibility. It cannot verify a real YouTube account or prove the screenshot is genuine.",
          "Your manual Approve, Reject or Flag action remains available."
        ].join("\n");
        await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/editMessageCaption", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: adminId, message_id: adminMessageId, caption })
        }).catch(error => console.error("MaseNet AI review caption update failed:", String(error)));
      }
      await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: adminId,
          text: "⏱️ " + aiLabel + "\nApplicant: " + fullName + "\nTelegram ID: " + chatId + "\nAI note: " + reason + "\n\nThis is not genuine YouTube verification. Your manual Approve, Reject or Flag action remains available."
        })
      }).catch(error => console.error("MaseNet admin AI screening notice failed:", String(error)));
      await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: aiAvailable && String(verdict) === "likely_match"
            ? "🟡 AI visual screening suggests the screenshot may show the correct MaseMedia TV channel and a subscribed state. Provisional MaseNet access is available after the five-second timeout. IMPORTANT: this is not genuine YouTube verification. The admin can still review your screenshot and may require re-verification."
            : "🟡 Provisional MaseNet access was granted after the five-second timeout, but AI could not confidently confirm the required channel and subscribed state. This is NOT genuine YouTube verification. The admin must review your screenshot and may require a genuine replacement."
        })
      }).catch(error => console.error("MaseNet user AI screening notice failed:", String(error)));
    } catch (error) {
      console.error("MaseNet five-second AI screenshot review failed:", error instanceof Error ? error.stack || error.message : String(error));
    }
  })());

  return json({
    submitted: true,
    pending: true,
    verified: false,
    message: "Your screenshot has been sent to the MaseNet admin. If no admin decision is made within five seconds, provisional access is granted automatically. This does not verify a genuine YouTube subscription; manual admin approval is still required for genuine verification."
  }, 202);
};
