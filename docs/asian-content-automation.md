# MaseNet Asian content automation

## Current implementation
- Isolated preview Worker: `masenet-asian-discovery-preview`.
- Preview D1: `masenet-asian-discovery-preview`; separate from production D1.
- Cron: every six hours at minute 15 UTC.
- Sources: Internet Archive metadata API and Wikimedia Commons MediaWiki API.
- The Worker checks source licence declarations and a direct video HEAD response before auto-publishing to the preview database's existing `titles` schema.
- It records every discovered item and scan run in `asian_discovery_items` and `asian_discovery_runs`.
- Duplicate titles are not overwritten. Unknown, NC, ND, missing licence, short/unknown duration, and non-playable files are held in `needs_review`.
- It only attempts feature-length videos (20 minutes or longer); short clips are not labelled as movies.

## Important limits
- Archive and Commons licence metadata is supplied by uploaders. It is a useful automated filter, not conclusive proof of copyright ownership. Production publishing must additionally require a trusted source/uploader allowlist or verified rights-holder documentation.
- This first worker discovers eligible film/video works. It does not scrape Viki, KBS, JFF Theater, or YouTube streaming players.
- Current Asian TV drama episodes require distributor/creator feeds or written redistribution permissions; they are not yet covered by this archive scanner.
- The Worker is not yet connected to the production D1 database or production Telegram bot. Production remains unchanged.

## Preview endpoints
- `GET /health`
- `GET /status`

## Production migration
`migrations/0003_asian_discovery.sql` is an additive migration for the existing production D1 schema. Do not apply it to production until preview verification and explicit release approval.
