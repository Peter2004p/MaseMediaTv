# Cloudflare API migration contract

The original UI expects the following routes and response shapes. Keep this contract while porting backend behavior; do not mark migration complete until each route is implemented and tested.

- `GET /api/titles` → `{ titles: Title[] }`; `POST /api/titles` → `{ title: Title }`; `PUT/DELETE /api/titles/:id` admin-only.
- `GET/POST /api/broadcasts` → `{ posts: Broadcast[] }`; writes admin-only.
- `GET/POST /api/homepage-settings` → `{ rows: string[] }`; writes admin-only.
- `GET/POST /api/site-theme` → `{ theme: string }`; writes admin-only.
- `POST /api/auth/telegram` validates Telegram WebApp initData using the bot token and short timestamp tolerance.
- `GET /api/auth/me`, `GET /api/auth/google`, `POST /api/auth/logout` establish secure session authentication. Admin identity must be checked server-side against `pb5089780@gmail.com`.
- `POST /api/media/upload` validates admin session, MIME, size and folder; stores objects in R2 and returns `{ url, path, contentType }`.
- `/api/media/url`, `/api/media/proxy`, `/api/media/convert` need secure allowlists and streaming support; do not permit arbitrary proxy URLs (SSRF risk).
- `POST /api/ai`, `/api/ai-settings`, `/api/ai-reports`, `/api/telegram/status`, `/api/telegram/setup`, and `/api/telegram/webhook/masetv` require Cloudflare secrets and behavior parity.

## Safety gates before cutover
1. Configure and test Google OAuth redirect URIs for the final Pages domain.
2. Set secrets with Cloudflare secret bindings only; never commit bot tokens or OAuth secrets.
3. Create a fresh D1 database and apply migrations there; do not touch the live AppDeploy database.
4. Add R2 media storage and test large-file behavior within free-tier limits.
5. Test anonymous access, non-admin access, admin CRUD, player playback/subtitles, AI errors, and Telegram webhook signature.
6. Update Telegram webhook only after the deployed API passes the checks; retain a rollback path.
