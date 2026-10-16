# MaseNet development notes

## Repository contents
- `index.html`: responsive public homepage scaffold.
- `admin.html`: expanded MaseNet Studio admin workspace with separate normal/automatic bulk URL draft tools, movie/drama metadata preview, read-only library filters, and planned feature sections.
- `functions/api/health.js`: API health endpoint.
- `functions/api/catalog.js`: read-only public catalog endpoint with an explicit public-field allowlist; excludes `video_url` and `subtitle_url`.
- `functions/api/admin/login.js`: session login endpoint scaffold.
- `functions/api/admin/me.js`: current session check.
- `functions/api/admin/logout.js`: session revocation.\n- `functions/api/admin/import.js`: authenticated bulk/single-item import with URL validation, per-row results, and duplicate media URL checks.
- `functions/api/admin/catalog.js`: authenticated, read-only admin catalog search that includes source and subtitle URLs only after a valid admin session.
- `functions/api/admin/item/[id].js`: authenticated single-item update (`PATCH`/`PUT`) and delete (`DELETE`) endpoint with type, title, HTTPS URL, year, and episode validation.

## Verified D1 schema (read-only inspection)
- `admins`: `id INTEGER PRIMARY KEY CHECK(id=1)`, `salt TEXT NOT NULL`, `password_hash TEXT NOT NULL`, `created_at TEXT DEFAULT CURRENT_TIMESTAMP`.
- `sessions`: `token_hash TEXT PRIMARY KEY`, `expires_at INTEGER NOT NULL`.
- `catalog`: `id TEXT PRIMARY KEY`, `type TEXT NOT NULL`, `title TEXT NOT NULL`, `description`, `poster`, `category`, `year`, `rating`, `video_url`, `subtitle_url`, `episode_of`, `episode_number`, `created_at`.

A read-only inspection found one admin row, two session rows, and one catalog row. No SQL rows were changed during inspection.

## Admin feature status
The admin page now includes separate Normal Bulk URLs and Automatic Bulk URLs forms. Both validate and preview rows, and submit to `/api/admin/import` when an authenticated session is present. The Media Library search/filter now calls `/api/admin/catalog`, which returns private source/subtitle URLs only after session validation. A protected `/api/admin/item/:id` endpoint has been added for updating and deleting catalog items, but the page UI does not yet expose edit/delete controls. The endpoint validates each row, skips existing media URLs, and returns per-row status. It is not deployed or production-tested. The Automatic tool generates sequential episode-number drafts from one URL per line. Movie/drama metadata, library filters, reel, broadcast, Telegram, homepage, user, and settings sections are present at varying scaffold levels; most require backend APIs before they are functional.

The public `/api/catalog` endpoint intentionally returns only public metadata fields and must never use `SELECT *`, because `video_url` and `subtitle_url` are private source fields. A future authenticated admin catalog endpoint is needed for editing and private media management.

## Authentication caveat — do not deploy yet
The login endpoint currently assumes `password_hash` equals SHA-256(password + salt). The database column is a 64-character hexadecimal string, but that alone does NOT prove the original hashing formula. Confirm the original admin provisioning code and hash formula before deployment; otherwise valid login attempts may fail. This scaffold does not implement rate limiting or automated expired-session cleanup. Add both before production use. The import endpoint currently relies on the existing session table and login implementation; do not deploy until the original password hash formula is verified and rate limiting is added. No credentials are stored in Git.

## Safe next steps
1. Confirm the original password hash formula from existing source/provisioning code.
2. Add rate limiting and expired-session cleanup.
3. Protect every mutation endpoint with server-side authentication and validation.
4. Add R2 upload support with type/size restrictions and authorized-media policy.
5. Test on a separate Cloudflare Pages preview project; do not attach this repository to the existing production project until reviewed.

Never commit credentials, session secrets, or production tokens.
