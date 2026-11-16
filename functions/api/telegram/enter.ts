import { onRequestPost as checkAccess } from "./access-status";
import { onRequestPost as createTelegramSession } from "../auth/telegram";

interface Env { DB: D1Database; TELEGRAM_BOT_TOKEN?: string; }
const noStore = { "Cache-Control": "no-store" };

// One server-side operation: validate Telegram identity, refresh membership,
// enforce verification/restrictions, then issue the app session cookie.
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const body = await request.json().catch(() => ({})) as { initData?: string };
  const initData = String(body.initData || "");
  if (!initData) return Response.json({ error: "Open MaseNet from the Telegram bot and try again." }, { status: 401, headers: noStore });
  const internalRequest = () => new Request(request.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData })
  });
  const accessResponse = await checkAccess({ request: internalRequest(), env });
  const access = await accessResponse.json().catch(() => ({})) as Record<string, any>;
  if (!accessResponse.ok) return Response.json(access, { status: accessResponse.status, headers: noStore });
  if (!access.accessGranted) return Response.json({ ...access, verificationRequired: true }, { headers: noStore });

  const authResponse = await createTelegramSession({ request: internalRequest(), env });
  const auth = await authResponse.json().catch(() => ({})) as Record<string, any>;
  if (!authResponse.ok || !auth.user) {
    return Response.json({ ...access, ...auth, accessGranted: true, sessionCreated: false }, { status: authResponse.status || 502, headers: noStore });
  }
  const headers = new Headers({ "Content-Type": "application/json", ...noStore });
  const cookie = authResponse.headers.get("Set-Cookie");
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify({ ...access, accessGranted: true, sessionCreated: true, user: auth.user }), { status: 200, headers });
};
