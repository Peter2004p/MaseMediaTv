interface Env {
  DB?: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  MEDIA_BUCKET?: R2Bucket;
  AI?: unknown;
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
    aiAssistant: Boolean(env.AI),
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
    stage: "migration",
    productionReady,
    readiness,
    catalogueCount,
    note: productionReady
      ? "Core service bindings are present. Complete admin, upload, Telegram, and playback end-to-end tests before cutover."
      : "Migration preview only. One or more required services or catalogue data are not ready; the existing production site has not been changed."
  }, { headers: { "Cache-Control": "no-store" } });
};
