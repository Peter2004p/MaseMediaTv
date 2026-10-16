# MaseNet development notes

## Current repository contents
- index.html: responsive public homepage scaffold with search and category filters.
- admin.html: admin workspace UI preview and bulk URL draft validator.
- functions/api/health.js: minimal API health endpoint.
- functions/api/catalog.js: intended read-only D1 catalog endpoint.

## Important limitations
This is an incremental scaffold, not a complete production streaming platform. The admin UI intentionally does not upload media or write catalog data. The API refuses writes until secure server-side admin authentication, session handling, and validation are implemented and tested.

The catalog endpoint assumes a D1 binding named DB and title and description columns for search. Verify the actual schema before deployment. It initially selects all catalog columns; before public deployment, restrict returned fields to non-sensitive catalog fields.

## Safe next steps
1. Verify the actual D1 schema and align the read query.
2. Implement login/session endpoints with server-side password hashing and expiring sessions.
3. Protect every mutation endpoint with server-side authentication and validation.
4. Add R2 upload support with content-type/size restrictions and authorized-media policy.
5. Test in a separate Cloudflare Pages preview project; do not attach this repository to the existing production project until reviewed.

Never commit credentials, session secrets, or production tokens.
