interface Env {
  DB?: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_PROMO_CRON_SECRET?: string;
  PROMO_CRON_SECRET?: string;
  ADMIN_TELEGRAM_CHAT_ID?: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  // Match the scheduled dispatcher's shared secret contract. Cloudflare's cron
  // Worker uses PROMO_CRON_SECRET; TELEGRAM_PROMO_CRON_SECRET remains supported
  // for existing manual/admin integrations.
  const expectedSecrets = [env.PROMO_CRON_SECRET, env.TELEGRAM_PROMO_CRON_SECRET]
    .map(value => String(value || "").trim()).filter(Boolean);
  const supplied = String(request.headers.get("authorization") || "").trim();
  if (!expectedSecrets.length || !expectedSecrets.some(secret => supplied === "Bearer " + secret)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const checks: Record<string, unknown> = {
    authenticated: true,
    pagesCronSecretConfigured: expectedSecrets.length > 0,
    d1Configured: !!env.DB,
    telegramBotTokenConfigured: !!env.TELEGRAM_BOT_TOKEN,
    adminChatConfigured: !!env.ADMIN_TELEGRAM_CHAT_ID
  };

  if (!env.DB) return json({ ok: false, checks, error: "D1 binding unavailable" }, 503);

  try {
    const [targets, catalogue, tables] = await Promise.all([
      env.DB.prepare("SELECT chat_type, COUNT(*) AS count FROM telegram_subscribers WHERE active=1 AND chat_type IN ('private','channel','supergroup') GROUP BY chat_type").all<{chat_type:string;count:number}>(),
      env.DB.prepare("SELECT name,description,poster_url,metadata_json FROM titles ORDER BY created_at DESC LIMIT 60").all<{name:string;description:string|null;poster_url:string|null;metadata_json:string|null}>(),
      env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('telegram_promo_history','telegram_promo_engagement_history','telegram_social_draft_history','telegram_promo_delivery_metrics')").all<{name:string}>()
    ]);
    let recentDeliveryRuns: Array<Record<string, unknown>> = [];
    if ((tables.results || []).some(row => row.name === "telegram_promo_delivery_metrics")) {
      try {
        const metrics = await env.DB.prepare(
          "SELECT sent_at,content_type,delivered,failed,targets,failure_category,failure_count,failure_detail FROM telegram_promo_delivery_metrics ORDER BY sent_at DESC LIMIT 12"
        ).all<{sent_at:string;content_type:string;delivered:number;failed:number;targets:number;failure_category:string;failure_count:number;failure_detail?:string}>();
        recentDeliveryRuns = (metrics.results || []).map(row => ({
          sentAt: row.sent_at,
          contentType: row.content_type,
          delivered: Number(row.delivered || 0),
          failed: Number(row.failed || 0),
          targets: Number(row.targets || 0),
          failureCategory: row.failure_category,
          failureCount: Number(row.failure_count || 0),
          failureDetail: String(row.failure_detail || "").slice(0, 180)
        }));
      } catch (error) {
        console.error("Telegram promotion delivery metrics could not be read:", error instanceof Error ? error.message : String(error));
      }
    }

    const counts = { private: 0, channel: 0, supergroup: 0 };
    for (const row of targets.results || []) {
      if (row.chat_type === "private" || row.chat_type === "channel" || row.chat_type === "supergroup") counts[row.chat_type] = Number(row.count || 0);
    }
    const eligible = (catalogue.results || []).filter(row => !!String(row.name || "").trim()).length;
    const enriched = (catalogue.results || []).filter(row => {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>; } catch {}
      const poster = String(row.poster_url || meta.posterUrl || "");
      const description = String(row.description || meta.description || "").trim();
      return /^https:\/\//i.test(poster) && description.length > 0;
    }).length;

    checks.subscriberCounts = counts;
    checks.totalSubscriberTargets = counts.private + counts.channel + counts.supergroup;
    checks.fixedChannelTarget = "@MaseMediaTv";
    checks.totalBroadcastTargets = counts.private + counts.channel + counts.supergroup + 1;
    checks.eligibleCatalogueItems = eligible;
    checks.catalogueItemsWithPosterAndDescription = enriched;
    checks.recentDeliveryRuns = recentDeliveryRuns;
    checks.promotionHistoryTables = (tables.results || []).map(row => row.name);
    checks.readyForScheduledDispatch = !!env.TELEGRAM_BOT_TOKEN &&
      (counts.private + counts.channel + counts.supergroup > 0) && eligible > 0;
    return json({ ok: true, checks, note: "Read-only diagnostic. No Telegram messages, polls, or social posts were sent." });
  } catch (error) {
    return json({
      ok: false,
      checks,
      error: "D1 diagnostic query failed",
      detail: error instanceof Error ? error.message.slice(0, 180) : "Unknown error"
    }, 500);
  }
};

export const onRequestGet = async () => json({ ok: false, error: "Use the diagnostic page and submit the secret in a POST header." }, 405);
