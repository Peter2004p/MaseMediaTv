export const onRequestGet: PagesFunction = async () => {
  return Response.json({
    ok: true,
    app: "MaseTv",
    platform: "Cloudflare Pages Functions",
    stage: "migration-scaffold",
    productionReady: false,
  }, { headers: { "Cache-Control": "no-store" } });
};
