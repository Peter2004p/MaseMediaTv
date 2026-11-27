interface Env {}
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

// YouTube subscription and screenshot verification have been retired.
// Keep this endpoint as a safe compatibility response for older app builds.
export const onRequestPost = async () =>
  json({ error: "YouTube and screenshot verification have been removed. Join both official MaseNet Telegram channels and use Check Membership." }, 410);
