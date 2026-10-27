import { json, requireAdmin } from "../auth/_shared";

interface Env {
  DB: D1Database;
  ADMIN_EMAIL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_MINI_APP_URL?: string;
  TELEGRAM_WEBAPP_URL?: string;
}

export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;

  if (!env.TELEGRAM_BOT_TOKEN) {
    return json({ ok: false, configured: false, error: "TELEGRAM_BOT_TOKEN is not configured." }, 503);
  }

  try {
    const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/getWebhookInfo");
    const data = await response.json().catch(() => ({})) as {
      ok?: boolean;
      description?: string;
      result?: {
        url?: string;
        pending_update_count?: number;
        last_error_date?: number;
        last_error_message?: string;
        allowed_updates?: string[];
      };
    };
    if (!response.ok || !data.ok || !data.result) {
      return json({ ok: false, error: data.description || "Telegram could not return webhook status." }, 502);
    }

    let info = data.result;
    const expectedUrl = "https://masetv-cloudflare-migration.pages.dev/api/telegram/webhook/masetv";
    let autoRepairAttempted = false;
    let autoRepairSucceeded = false;
    // Keep the live bot webhook on the stable production hostname and make sure
    // channel posts reach the subscription handler. This runs only for an authenticated admin.
    if (env.TELEGRAM_WEBHOOK_SECRET && (info.url !== expectedUrl || !(info.allowed_updates || []).includes("channel_post"))) {
      autoRepairAttempted = true;
      try {
        const repair = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/setWebhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: expectedUrl,
            drop_pending_updates: false,
            allowed_updates: ["message", "edited_message", "channel_post", "my_chat_member"],
            secret_token: env.TELEGRAM_WEBHOOK_SECRET
          })
        });
        const repairData = await repair.json().catch(() => ({})) as { ok?: boolean };
        autoRepairSucceeded = repair.ok && repairData.ok === true;
        if (autoRepairSucceeded) {
          const refreshed = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/getWebhookInfo");
          const refreshedData = await refreshed.json().catch(() => ({})) as { ok?: boolean; result?: typeof info };
          if (refreshed.ok && refreshedData.ok && refreshedData.result) info = refreshedData.result;
        }
      } catch (error) {
        console.error("MaseNet Telegram webhook auto-repair failed:", error instanceof Error ? error.message : String(error));
      }
    }
    const urlMatches = info.url === expectedUrl;
    const row = await env.DB.prepare("SELECT value_json FROM site_settings WHERE key='telegram_webhook'").first<{ value_json: string }>();
    let recorded = false;
    try { recorded = Boolean(row && JSON.parse(row.value_json).configured === true); } catch {}

    return json({
      ok: true,
      botConfigured: true,
      webhookConfigured: Boolean(info.url),
      webhookUrl: info.url || "",
      webhookMatchesThisDeployment: urlMatches,
      webhookRecordedInDatabase: recorded,
      secretConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
      miniAppUrlConfigured: Boolean(((env.TELEGRAM_MINI_APP_URL || env.TELEGRAM_WEBAPP_URL || "").trim()).startsWith("https://")),
      pendingUpdateCount: info.pending_update_count ?? 0,
      lastErrorDate: info.last_error_date ?? null,
      lastErrorMessage: info.last_error_message ?? null,
      allowedUpdates: info.allowed_updates ?? [],
      autoRepairAttempted,
      autoRepairSucceeded,
      note: info.last_error_message
        ? "Telegram reports a delivery error. Review lastErrorMessage and check the deployed webhook route and secrets."
        : !urlMatches
          ? "Telegram webhook points to a different URL than this deployment."
          : "Telegram webhook is registered. Confirm by sending /start to the bot."
    });
  } catch {
    return json({ ok: false, error: "Unable to contact Telegram right now." }, 502);
  }
};
