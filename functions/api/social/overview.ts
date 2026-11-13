import { Env, json, currentAdmin } from "../auth/_shared";

type SocialEnv = Env;

export const onRequestGet: PagesFunction<SocialEnv> = async ({ request, env }) => {
  const admin = await currentAdmin(request, env);
  if (!admin || admin.role !== "owner") return json({ error: "Only the MaseNet owner can view social activity." }, 403);

  const [connections, draftCounts, recentDrafts, promoTotals, recentPromos, subscriberCounts] = await Promise.all([
    env.DB.prepare("SELECT provider, channel_id AS channelId, channel_title AS channelTitle, connected_at AS connectedAt, updated_at AS updatedAt FROM social_connections ORDER BY provider").all<{provider:string;channelId:string;channelTitle:string;connectedAt:string;updatedAt:string}>(),
    env.DB.prepare("SELECT status, COUNT(*) AS total FROM social_comment_drafts GROUP BY status").all<{status:string;total:number}>(),
    env.DB.prepare("SELECT comment_id AS commentId, video_title AS videoTitle, author, comment_text AS commentText, draft_text AS replyText, status, created_at AS createdAt, published_at AS publishedAt, last_error AS lastError FROM social_comment_drafts ORDER BY created_at DESC LIMIT 8").all(),
    env.DB.prepare("SELECT COALESCE(SUM(delivered),0) AS delivered, COALESCE(SUM(failed),0) AS failed, COALESCE(SUM(targets),0) AS targets, COUNT(*) AS batches FROM telegram_promo_delivery_metrics WHERE sent_at >= datetime('now','-7 days')").first<{delivered:number;failed:number;targets:number;batches:number}>(),
    env.DB.prepare("SELECT sent_at AS sentAt, content_type AS contentType, delivered, failed, targets, failure_detail AS failureDetail FROM telegram_promo_delivery_metrics ORDER BY sent_at DESC LIMIT 8").all(),
    env.DB.prepare("SELECT chat_type AS chatType, COUNT(*) AS total, SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active FROM telegram_subscribers GROUP BY chat_type").all<{chatType:string;total:number;active:number}>()
  ]);

  const connected = (connections.results || []).map(item => ({
    provider: item.provider,
    channelId: item.channelId,
    channelTitle: item.channelTitle.trim(),
    connectedAt: item.connectedAt,
    updatedAt: item.updatedAt
  }));
  const counts = Object.fromEntries((draftCounts.results || []).map(item => [item.status, Number(item.total) || 0]));
  return json({
    checkedAt: new Date().toISOString(),
    connections: connected,
    youtube: {
      connected: connected.some(item => item.provider === "youtube"),
      replies: {
        published: counts.published || 0,
        pending: counts.pending || 0,
        failed: counts.failed || 0,
        skipped: counts.skipped || 0,
        recent: recentDrafts.results || []
      },
      mode: "automatic_with_safety_filters"
    },
    telegram: {
      subscribers: subscriberCounts.results || [],
      promotionsLast7Days: {
        delivered: Number(promoTotals?.delivered) || 0,
        failed: Number(promoTotals?.failed) || 0,
        targets: Number(promoTotals?.targets) || 0,
        batches: Number(promoTotals?.batches) || 0
      },
      recentPromotions: recentPromos.results || []
    },
    platforms: {
      youtube: connected.some(item => item.provider === "youtube"),
      facebook: false,
      instagram: false,
      tiktok: false
    }
  });
};
