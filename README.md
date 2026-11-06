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


## Live Telegram access-gate end-to-end test

Run this only with a **dedicated Telegram test account** that you control. The test submits a signed test update to the deployed webhook and writes the YouTube-verification result for that Telegram user into the production D1 access table. It also sends bot replies to that test account. Do not use a customer account.

Requirements: Node.js 20+ and the following environment variables (never commit them):

- `TELEGRAM_BOT_TOKEN`: the production bot token.
- `TELEGRAM_WEBHOOK_SECRET`: the exact secret configured on the production webhook.
- `TELEGRAM_TEST_USER_ID`: numeric Telegram user/chat ID of your dedicated private test account.
- `TELEGRAM_TEST_YOUTUBE_FILE_ID`: a photo `file_id` received by this bot from that test account; the screenshot must visibly show `@masemedia_tv` as Subscribed.
- Optional `MASETV_BASE_URL`: defaults to `https://masetv-cloudflare-migration.pages.dev`.
- Optional `OPENAI_API_KEY` and `OPENAI_MODEL`: used for an independent vision preflight; the deployed webhook still uses its own Cloudflare secret binding.

Run:

```sh
npm run test:telegram-e2e
```

The script checks bot identity and webhook configuration, calls Telegram `getChatMember` for `@MaseMediaTv` and `@MoonDramaC`, downloads the supplied screenshot from Telegram and checks it with OpenAI vision, then posts a signed photo update and a signed `/verify` update to the live Pages Function. It fails on any non-member status, screenshot rejection, webhook error, or missing `accessGranted: true` response. This is a live integration test, not a mock; it cannot prove YouTube subscription cryptographically because screenshot review is visual evidence only.
