# MaseTv — Cloudflare migration

This branch is a separate migration workspace. The original AppDeploy source snapshot is preserved under `appdeploy-source/` on the `appdeploy-source-backup` branch and is not modified by this migration.

## Current stage
- Source backup is preserved in GitHub.
- Cloudflare Pages Functions and an initial D1 schema are being prepared here.
- This branch is intentionally not configured for production deployment yet. Do not connect it to production or change the Telegram webhook until the API adapter, authentication, media storage, admin routes, and end-to-end checks are complete.

## Required migration work
1. Replace `@appdeploy/client` frontend calls with a Cloudflare-compatible fetch adapter.
2. Port AppDeploy backend routes to Pages Functions and D1.
3. Configure secure admin authentication and session cookies.
4. Configure media storage and preserve player/proxy behavior.
5. Add secrets through Cloudflare settings (never commit tokens).
6. Build, test, and verify the Mini App and bot webhook before cutover.
