import { json } from "../auth/_shared";
interface Env { DB: D1Database; }

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const titleId = String(url.searchParams.get("titleId") || "").trim();
  const mediaKind = String(url.searchParams.get("mediaKind") || "").trim();

  // The public Downloads page must be able to list published vault files
  // independently of the catalogue: a published asset can outlive its title.
  if (!titleId && !mediaKind) {
    const rows = await env.DB.prepare(
      "SELECT id,title_id,media_kind,title,release_year,season,episode,episode_title,quality,codec,file_name,file_size,container_format,language FROM telegram_media_assets WHERE status='published' AND rights_confirmed=1 ORDER BY created_at DESC LIMIT 100"
    ).all();
    return json({ok:true,assets:rows.results||[]});
  }

  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(titleId) || !["movie","drama"].includes(mediaKind)) {
    return json({ ok:false, error:"A valid title and media type are required." },400);
  }
  const season = Number(url.searchParams.get("season") || 0);
  const episode = Number(url.searchParams.get("episode") || 0);
  if (mediaKind === "drama" && (!Number.isInteger(season) || season < 1 || season > 99 || !Number.isInteger(episode) || episode < 1 || episode > 999)) {
    return json({ ok:false,error:"A valid season and episode are required." },400);
  }
  const rows = mediaKind === "drama"
    ? await env.DB.prepare("SELECT id,title_id,media_kind,title,release_year,quality,codec,file_name,episode_title,season,episode FROM telegram_media_assets WHERE title_id=? AND media_kind='drama' AND season=? AND episode=? AND status='published' AND rights_confirmed=1 ORDER BY CASE quality WHEN '2160p' THEN 1 WHEN '1440p' THEN 2 WHEN '1080p' THEN 3 WHEN '720p' THEN 4 WHEN '576p' THEN 5 WHEN '480p' THEN 6 ELSE 7 END,created_at DESC").bind(titleId,season,episode).all()
    : await env.DB.prepare("SELECT id,title_id,media_kind,title,release_year,quality,codec,file_name,episode_title,season,episode FROM telegram_media_assets WHERE title_id=? AND media_kind='movie' AND status='published' AND rights_confirmed=1 ORDER BY CASE quality WHEN '2160p' THEN 1 WHEN '1440p' THEN 2 WHEN '1080p' THEN 3 WHEN '720p' THEN 4 WHEN '576p' THEN 5 WHEN '480p' THEN 6 ELSE 7 END,created_at DESC").bind(titleId).all();
  return json({ok:true,assets:rows.results||[]});
};
