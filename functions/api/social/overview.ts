import { Env, json, currentAdmin } from "../auth/_shared";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const admin = await currentAdmin(request, env);
  if (!admin || admin.role !== "owner") {
    return json({ error: "Only the MaseNet owner can view social connections." }, 403);
  }

  try {
    const [
      connectionRows,
      replyRows,
      recentReplyRows,
      promoTotals,
      recentPromos,
      subscriberCount
    ] = await Promise.all([
      env.DB.prepare(
        "SELECT provider, channel_id AS channelId, channel_title AS channelTitle, connected_at AS connectedAt FROM social_connections ORDER BY provider"
      ).all<{
        provider: string;
        channelId: string;
        channelTitle: string;
        connectedAt: string;
      }>(),
      env.DB.prepare(
        "SELECT status, COUNT(*) AS total FROM social_comment_drafts GROUP BY status"
      ).all<{ status: string; total: number }>(),
      env.DB.prepare(
        "SELECT comment_id AS commentId, video_title AS videoTitle, author, comment_text AS commentText, draft_text AS replyText, status, created_at AS createdAt, published_at AS publishedAt, last_error AS lastError FROM social_comment_drafts ORDER BY COALESCE(published_at, created_at) DESC LIMIT 10"
      ).all<{
        commentId: string;
        videoTitle: string | null;
        author: string | null;
        commentText: string | null;
        replyText: string;
        status: string;
        createdAt: string;
        publishedAt: string | null;
        lastError: string | null;
      }>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS batches, COALESCE(SUM(delivered), 0) AS delivered, COALESCE(SUM(failed), 0) AS failed, COALESCE(SUM(targets), 0) AS targets FROM telegram_promo_delivery_metrics WHERE datetime(sent_at) >= datetime('now', '-7 days')"
      ).first<{
        batches: number;
        delivered: number;
        failed: number;
        targets: number;
      }>(),
      env.DB.prepare(
        "SELECT sent_at AS sentAt, content_type AS contentType, delivered, failed, targets, failure_detail AS failureDetail FROM telegram_promo_delivery_metrics ORDER BY sent_at DESC LIMIT 12"
      ).all<{
        sentAt: string;
        contentType: string;
        delivered: number;
        failed: number;
        targets: number;
        failureDetail: string;
      }>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS total FROM telegram_subscribers WHERE active = 1"
      ).first<{ total: number }>()
    ]);

    const connections = connectionRows.results || [];
    const replyCounts = {
      published: 0,
      pending: 0,
      failed: 0,
      skipped: 0
    };
    for (const row of replyRows.results || []) {
      if (row.status in replyCounts) {
        replyCounts[row.status as keyof typeof replyCounts] = Number(row.total || 0);
      }
    }

    const youtube = connections.find((item) => item.provider === "youtube") || null;
    const totals = promoTotals || { batches: 0, delivered: 0, failed: 0, targets: 0 };

    return json({
      checkedAt: new Date().toISOString(),
      connections,
      youtube: {
        connected: Boolean(youtube),
        channel: youtube,
        replies: {
          ...replyCounts,
          recent: recentReplyRows.results || []
        }
      },
      telegram: {
        activeSubscribers: Number(subscriberCount?.total || 0),
        promotionsLast7Days: {
          batches: Number(totals.batches || 0),
          delivered: Number(totals.delivered || 0),
          failed: Number(totals.failed || 0),
          targets: Number(totals.targets || 0)
        },
        recentPromotions: recentPromos.results || []
      }
    });
  } catch (error) {
    console.error(
      "MaseNet social activity overview failed:",
      error instanceof Error ? error.message : String(error)
    );
    return json({ error: "Social activity is temporarily unavailable. Please refresh shortly." }, 503);
  }
};
