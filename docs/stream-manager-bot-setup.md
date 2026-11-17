# MaseNet Stream Manager Bot setup

This bot is separate from @MaseTv_Bot. It is restricted to the configured admin Telegram account and proposes catalogue changes for explicit approval.

## Cloudflare Pages environments

The Pages project uses separate D1 databases:

- **Production:** the existing live MaseNet catalogue database. Do not change this binding during preview setup.
- **Preview:** the isolated `masetv-mkv-preview-db` database. The Preview `DB` binding must point to this database, never the Production database.

The Preview database is isolated and may not contain the full MaseNet schema or catalogue data. Initialise only the schema required for the test, and use test records. Never copy live catalogue data into it just to test this bot.

Preview deployments are currently disabled. Do not enable them until the Preview secrets and isolated database binding have been checked.

## Required Pages secrets

Configure these values separately in the **Preview** environment:

- `MASE_STREAM_BOT_TOKEN`: token for @MaseNetStreamManagerBot.
- `MASE_STREAM_BOT_WEBHOOK_SECRET`: the dedicated random webhook secret for this bot.
- `ADMIN_TELEGRAM_CHAT_ID`: the existing numeric admin Telegram user/chat ID.

The secret values are not readable back from Cloudflare after saving. Copy them from your secure password/secret manager; do not paste them into GitHub or chat. The Production environment already has its own variables; do not overwrite or rotate them for preview testing.

The Pages Functions binding must be named `DB` and point to the isolated Preview D1 database.

## Register the preview webhook

Only after a preview deployment is available and its environment has been verified, register the bot webhook against that preview hostname:

```bash
curl -X POST "https://api.telegram.org/bot<MASE_STREAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<PREVIEW_HOST>/api/telegram/stream-manager","secret_token":"<MASE_STREAM_BOT_WEBHOOK_SECRET>","allowed_updates":["message","callback_query"]}'
```

Replace placeholders locally; never commit a bot token or webhook secret. The webhook secret must be 1–256 characters using Telegram's supported characters. Do not point the bot at Production until the feature is reviewed and separately approved for release.

## Current workflow

1. Admin forwards a generated HTTPS stream URL to the new bot.
2. Bot parses available title/year/season/episode/quality/codec/format metadata and stores a private pending record.
3. Bot looks for an exact normalized title match.
4. Admin explicitly presses Apply or Ignore.
5. Apply should create a new title/episode, add a missing episode, replace a matching quality+codec stream, or add another quality/codec variant.
6. A pending submission must be claimed atomically so repeated or concurrent callback taps cannot apply it twice.

The five-minute notice from KDLAirBot is treated as the lifetime of its Telegram message only. It does not mean the video URL expires. The bot must preserve the URL and test reachability separately where possible.

## Current implementation limits

- The current parser supports episode-style filenames containing SxxExxx and MKV/MP4/M4V/WEBM. Standalone movie filename support is not yet implemented.
- It does not press buttons in KDLAirBot, request new links from KDLAirBot, or download video files.
- It does not yet create new-episode announcements. Poster/description can be completed in the MaseNet Admin Library.
- URL reachability is not guaranteed by parsing. A protected or expiring provider URL may reject HEAD/Range checks; no universal reachability guarantee should be shown.
- Keep the bot in Preview until matching, replacement, concurrency, and catalogue-preservation tests pass.
