interface Env {
  DB?: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  MEDIA_BUCKET?: R2Bucket;
  AI?: unknown;
  OPENAI_API_KEY?: string;
}

export const onRequestGet = async ({ env }: { env: Env }) => {
  let catalogueCount: number | null = null;
  let databaseReady = false;
  try {
    if (env.DB) {
      const result = await env.DB.prepare("SELECT COUNT(*) AS count FROM titles").first<{ count: number }>();
      catalogueCount = Number(result?.count ?? 0);
      databaseReady = true;
    }
  } catch {
    databaseReady = false;
  }

  const readiness = {
    database: databaseReady,
    catalogueHasTitles: catalogueCount !== null && catalogueCount > 0,
    googleAdminLogin: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    telegramBot: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET),
    mediaStorage: Boolean(env.MEDIA_BUCKET),
    aiAssistant: Boolean(env.OPENAI_API_KEY || env.AI),
  };

  const productionReady = readiness.database
    && readiness.catalogueHasTitles
    && readiness.googleAdminLogin
    && readiness.telegramBot
    && readiness.mediaStorage;

  return Response.json({
    ok: true,
    app: "MaseNet",
    platform: "Cloudflare Pages Functions",
    stage: "deployed",
    productionReady,
    readiness,
    catalogueCount,
    note: productionReady
      ? "Core service bindings are present. Complete admin, upload, Telegram, and playback end-to-end tests before cutover."
      : "One or more required service bindings or catalogue data are not ready. This endpoint checks runtime bindings only; it does not certify every user workflow."
  }, { headers: { "Cache-Control": "no-store" } });
};
