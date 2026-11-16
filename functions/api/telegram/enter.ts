// Single public operation for Telegram Mini App access + session creation.
// Internally reuses the existing signed-initData access checker and session issuer.
interface Env { TELEGRAM_BOT_TOKEN?: string; }
const noStore = { "Cache-Control": "no-store" };
export const onRequestPost = async ({ request }: { request: Request }) => {
  const body = await request.json().catch(() => ({})) as { initData?: string };
  const initData = String(body.initData || "");
  if (!initData) return Response.json({ error: "Open MaseNet from the Telegram bot and try again." }, { status: 401, headers: noStore });
  const origin = new URL(request.url).origin;
  const statusResponse = await fetch(new URL("/api/telegram/access-status", origin), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData })
  });
  const status = await statusResponse.json().catch(() => ({})) as Record<string, any>;
  if (!statusResponse.ok) return Response.json(status, { status: statusResponse.status, headers: noStore });
  if (!status.accessGranted) return Response.json({ ...status, verificationRequired: true }, { headers: noStore });
  const authResponse = await fetch(new URL("/api/auth/telegram", origin), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData })
  });
  const auth = await authResponse.json().catch(() => ({})) as Record<string, any>;
  if (!authResponse.ok || !auth.user) return Response.json({ ...status, ...auth, accessGranted: true, sessionCreated: false }, { status: authResponse.status || 502, headers: noStore });
  const headers = new Headers({ "Content-Type": "application/json", ...noStore });
  const cookie = authResponse.headers.get("Set-Cookie");
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify({ ...status, accessGranted: true, sessionCreated: true, user: auth.user }), { status: 200, headers });
};
