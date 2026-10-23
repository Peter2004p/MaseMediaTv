import { Env, json, requireAdmin } from "../auth/_shared";

const META = "[[MASETNET_BROADCAST_META]]";
function unpack(raw: string, title: string) {
  if (raw.startsWith(META)) {
    const split = raw.indexOf("\\n");
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(raw.slice(META.length, split >= 0 ? split : undefined)) as Record<string, unknown>; } catch {}
    return { meta, description: split >= 0 ? raw.slice(split + 2) : "", heading: String(meta.heading || title) };
  }
  const marker = "[[MASETNET_HEADING]]";
  const at = raw.indexOf(marker);
  if (at < 0) return { meta: {}, description: raw, heading: title };
  const rest = raw.slice(at + marker.length);
  const divider = rest.indexOf("\\\\n");
  return { meta: {}, description: divider >= 0 ? rest.slice(divider + 3) : "", heading: divider >= 0 ? rest.slice(0, divider) : title };
}
export const onRequest: PagesFunction<Env> = async ({ request, env, params }) => {
  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;
  const id = String(params.id || "");
  if (!id || id.length > 200) return json({ error: "Invalid broadcast ID." }, 400);
  if (request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM broadcasts WHERE id = ?").bind(id).run();
    if (!result.meta.changes) return json({ error: "Broadcast not found." }, 404);
    return json({ success: true });
  }
  if (request.method !== "PUT" && request.method !== "PATCH") return json({ error: "Method not allowed." }, 405);
  const existing = await env.DB.prepare("SELECT id,title,description,media_url,target,expires_at,created_at FROM broadcasts WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!existing) return json({ error: "Broadcast not found." }, 404);
  const body = await request.json() as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : String(existing.title || "");
  const mediaUrl = typeof body.mediaUrl === "string" ? body.mediaUrl.trim() : String(existing.media_url || "");
  const destination = ["website", "telegram", "both"].includes(String(body.destination)) ? String(body.destination) : String(existing.target || "website");
  const expiresAt = body.expiresAt === null || body.expiresAt === "" ? null : typeof body.expiresAt === "string" ? body.expiresAt : existing.expires_at as string | null;
  if (!title) return json({ error: "A broadcast title is required." }, 400);
  if (!mediaUrl || !mediaUrl.startsWith("https://")) return json({ error: "A valid HTTPS media URL is required." }, 400);
  const previous = unpack(String(existing.description || ""), title);
  const description = typeof body.caption === "string" ? body.caption : typeof body.description === "string" ? body.description : previous.description;
  const heading = typeof body.heading === "string" ? body.heading.trim() : previous.heading;
  const metadata = {
    heading,
    mediaType: body.mediaType || previous.meta.mediaType || (/\.(mp4|webm|mov)(\?|$)/i.test(mediaUrl) ? "video" : /\.gif(\?|$)/i.test(mediaUrl) ? "gif" : "image"),
    billboardStyle: body.billboardStyle || previous.meta.billboardStyle,
    billboardTheme: body.billboardTheme || previous.meta.billboardTheme,
    billboardSize: body.billboardSize || previous.meta.billboardSize,
    billboardShape: body.billboardShape || previous.meta.billboardShape,
    billboardAnimation: body.billboardAnimation || previous.meta.billboardAnimation,
    buttonLabel: body.buttonLabel ?? previous.meta.buttonLabel,
    buttonUrl: body.buttonUrl ?? previous.meta.buttonUrl,
    bubbleMessage: body.bubbleMessage ?? previous.meta.bubbleMessage
  };
  const stored = META + JSON.stringify(metadata) + "\\n" + description;
  await env.DB.prepare("UPDATE broadcasts SET title = ?, description = ?, media_url = ?, target = ?, expires_at = ? WHERE id = ?")
    .bind(title, stored, mediaUrl, destination, expiresAt, id).run();
  const post = { id, title, heading, description, caption: description, mediaType: metadata.mediaType, mediaUrl, destination, expiresAt, createdAt: existing.created_at, billboardStyle: metadata.billboardStyle, billboardTheme: metadata.billboardTheme, billboardSize: metadata.billboardSize, billboardShape: metadata.billboardShape, billboardAnimation: metadata.billboardAnimation, buttonLabel: metadata.buttonLabel, buttonUrl: metadata.buttonUrl, bubbleMessage: metadata.bubbleMessage };
  return json({ success: true, post });
};
