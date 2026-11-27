interface Env {}
// Retired screenshot-review cron endpoint: never send obsolete screenshot/admin-approval notices.
export const onRequestPost: PagesFunction<Env> = async () =>
  Response.json({ ok: true, retired: true, sent: 0 }, { headers: { "Cache-Control": "no-store" } });
export const onRequestGet: PagesFunction<Env> = async () =>
  Response.json({ ok: true, retired: true }, { headers: { "Cache-Control": "no-store" } });
