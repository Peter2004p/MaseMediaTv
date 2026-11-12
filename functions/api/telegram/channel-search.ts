import { searchPublicTelegramChannel } from "../_telegram-channel";

export const onRequestGet = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 100);
  if (query.length < 2) return Response.json({ results: [] }, { headers: { "Cache-Control": "public, max-age=20" } });
  try {
    const results = await searchPublicTelegramChannel(query, 6);
    return Response.json({ results }, { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" } });
  } catch (error) {
    console.error("MaseNet Telegram channel search endpoint failed", error instanceof Error ? error.message : "unknown error");
    return Response.json({ results: [], unavailable: true }, { headers: { "Cache-Control": "no-store" } });
  }
};
