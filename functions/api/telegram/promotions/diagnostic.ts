interface Env {
  DB?: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_PROMO_CRON_SECRET?: string;
  ADMIN_TELEGRAM_CHAT_ID?: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const expected = String(env.TELEGRAM_PROMO_CRON_SECRET || "");
  const supplied = request.headers.get("authorization") || "";
  if (!expected || supplied !== "Bearer " + expected) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const checks: Record<string, unknown> = {
    authenticated: true,
    pagesCronSecretConfigured: !!expected,
    d1Configured: !!env.DB,
    telegramBotTokenConfigured: !!env.TELEGRAM_BOT_TOKEN,
    adminChatConfigured: !!env.ADMIN_TELEGRAM_CHAT_ID
  };

  if (!env.DB) return json({ ok: false, checks, error: "D1 binding unavailable" }, 503);

  try {
    const [targets, catalogue, tables] = await Promise.all([
      env.DB.prepare("SELECT chat_type, COUNT(*) AS count FROM telegram_subscribers WHERE active=1 AND chat_type IN ('private','channel','supergroup') GROUP BY chat_type").all<{chat_type:string;count:number}>(),
      env.DB.prepare("SELECT name,description,poster_url,metadata_json FROM titles ORDER BY created_at DESC LIMIT 60").all<{name:string;description:string|null;poster_url:string|null;metadata_json:string|null}>(),
      env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('telegram_promo_history','telegram_promo_engagement_history','telegram_social_draft_history')").all<{name:string}>()
    ]);

    const counts = { private: 0, channel: 0, supergroup: 0 };
    for (const row of targets.results || []) {
      if (row.chat_type === "private" || row.chat_type === "channel" || row.chat_type === "supergroup") counts[row.chat_type] = Number(row.count || 0);
    }
    const eligible = (catalogue.results || []).filter(row => {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>; } catch {}
      const poster = String(row.poster_url || meta.posterUrl || "");
      const description = String(row.description || meta.description || "").trim();
      return /^https:\/\//i.test(poster) && description.length > 0;
    }).length;

    checks.subscriberCounts = counts;
    checks.totalSubscriberTargets = counts.private + counts.channel + counts.supergroup;
    checks.eligibleCatalogueItems = eligible;
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
