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
  if (!hash || !authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) {
    return json({ error: "Open MaseNet again from Telegram and retry." }, 401);
  }
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  const checkString = entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), env.TELEGRAM_BOT_TOKEN);
  if (hex(await hmac(secret, checkString)) !== hash) return json({ error: "Telegram session validation failed." }, 401);

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
      reviewed_at TEXT
    )`).run();
    await env.DB.prepare(
      "INSERT INTO telegram_access_verification (chat_id,youtube_ok,updated_at) VALUES (?,0,datetime('now')) ON CONFLICT(chat_id) DO NOTHING"
    ).bind(chatId).run();
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
    "REVIEW WINDOW: 5 seconds. If you do not act, provisional access is granted automatically.",
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
          "Choose an action. If no decision is made within 5 seconds, provisional access is granted automatically."
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
      console.error("MaseNet admin review buttons delivery failed:", controls.status, controlsResult.description || "Unknown Telegram error");
      return json({ error: "Screenshot reached the admin, but Telegram could not deliver the approval buttons. Please retry the submission." }, 502);
    }
  } catch (error) {
    await env.DB.prepare("UPDATE telegram_access_submissions SET status='delivery_failed' WHERE id=?").bind(submissionId).run().catch(() => undefined);
    console.error("MaseNet admin screenshot delivery error:", error instanceof Error ? error.message : String(error));
    return json({ error: "Could not contact the admin review chat. Please try again shortly." }, 502);
  }


  // Five-second fallback: grant provisional access if the admin has not acted.
  // This is an operational timeout approval, NOT proof that the screenshot is genuine.
  // The admin can later flag an approved_timeout submission and start 24-hour re-verification.
  waitUntil((async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const current = await env.DB.prepare("SELECT status FROM telegram_access_submissions WHERE id=?").bind(submissionId).first<{status:string}>();
      if (!current || current.status !== "pending") return;
      const changed = await env.DB.prepare("UPDATE telegram_access_submissions SET status='approved_timeout',reviewed_at=datetime('now') WHERE id=? AND status='pending'").bind(submissionId).run();
      if (!Number(changed.meta?.changes || 0)) return;
      // Timeout grants only temporary access. It must never set the genuine verification flag.
      await env.DB.prepare("UPDATE telegram_access_verification SET youtube_ok=0,youtube_provisional=1,updated_at=datetime('now') WHERE chat_id=?").bind(chatId).run();
      if (adminMessageId) {
        await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/editMessageCaption", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: adminId,
            message_id: adminMessageId,
            caption: [
              "🛡️ MASENET — YOUTUBE SUBSCRIPTION REVIEW",
              "",
              "👤 Applicant: " + fullName,
              "🔖 Telegram: " + username,
              "🆔 Telegram user ID: " + chatId,
              "🕒 Submitted: " + submittedAt,
              "",
              "⏱️ FIVE-SECOND TIMEOUT: PROVISIONAL ACCESS GRANTED.",
              "⚠️ This is NOT genuine screenshot verification. Please inspect this proof.",
              "Use Flag / 24h restriction if the screenshot is fake or the task was not completed."
            ].join("\n")
          })
        }).catch(error => console.error("MaseNet provisional approval caption update failed:", error instanceof Error ? error.message : String(error)));
      }
      await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "⏱️ Your 5-second review window has ended. MaseNet has granted provisional access so you can continue. IMPORTANT: this is a temporary timeout approval, not confirmation that your screenshot or subscription is genuine. An admin may review it later. If your proof is fake or the task was not completed, your access may be challenged and you will receive 24 hours to submit genuine proof."
        })
      }).catch(error => console.error("MaseNet provisional approval notice failed:", error instanceof Error ? error.message : String(error)));
    } catch (error) {
      console.error("MaseNet five-second provisional approval failed:", error instanceof Error ? error.stack || error.message : String(error));
    }
  })());

  return json({
    submitted: true,
    pending: true,
    verified: false,
    message: "Your screenshot has been sent to the MaseNet admin. If no admin decision is made within five seconds, provisional access is granted automatically. This is not genuine screenshot verification and may be challenged by an admin later."
  }, 202);
};
