import { Env, json, currentAdmin } from "../../auth/_shared";
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const admin = await currentAdmin(request, env);
  if (!admin || admin.role !== "owner") return json({ error:"Only the MaseNet owner can view social connections." },403);
  const row = await env.DB.prepare("SELECT channel_id AS channelId, channel_title AS channelTitle, connected_at AS connectedAt FROM social_connections WHERE provider='youtube'").first<{channelId:string;channelTitle:string;connectedAt:string}>().catch(()=>null);
  return json({ provider:"youtube", connected:Boolean(row), channel:row || null, capabilities:["read_channel","read_comments","reply_to_comments"], replyMode:"approval_required" });
};
