# MaseNet Stream Manager Bot setup

This bot is separate from @MaseTv_Bot. It writes to the same Cloudflare D1 `titles` catalogue and is restricted to the configured admin Telegram account.

## Cloudflare Pages secrets

Add these secrets to the same Pages project and environment as the MaseNet webhook:

- `MASE_STREAM_BOT_TOKEN`: token for the new bot created with @BotFather.
- `MASE_STREAM_BOT_WEBHOOK_SECRET`: a new random secret (do not reuse the main bot webhook secret).
- `ADMIN_TELEGRAM_CHAT_ID`: existing numeric Telegram admin user/chat ID. The bot only accepts private messages from this ID.

The project must already have the `DB` D1 binding used by MaseNet. Do not create a second catalogue database.

## Register the webhook

After deploying the preview branch, register the new bot webhook against the preview hostname:

```bash
curl -X POST "https://api.telegram.org/bot<MASE_STREAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<PREVIEW_HOST>/api/telegram/stream-manager","secret_token":"<MASE_STREAM_BOT_WEBHOOK_SECRET>","allowed_updates":["message","callback_query"]}'
```

Replace placeholders locally; never commit a bot token or webhook secret. The webhook secret must be 1–256 characters using Telegram's supported characters.

## Current workflow

1. Admin forwards a generated HTTPS episode URL to the new bot.
2. Bot parses title/year/season/episode/quality/codec/format and stores a private pending record.
3. Bot looks for an exact normalized drama title match.
4. Admin explicitly presses Apply or Ignore.
5. Apply creates a new drama/first episode, adds a missing episode, replaces a matching quality+codec stream, or adds another quality/codec variant.
6. The pending record is marked processed so the same approval cannot be applied twice.

The five-minute notice from KDLAirBot is treated as the lifetime of its Telegram message only. This bot does not assume the video URL expires at the same time.

## Important current limits

- The first parser supports episode-style filenames containing SxxExxx and MKV/MP4/M4V/WEBM.
- It does not press buttons in KDLAirBot, request new links from KDLAirBot, or download video files.
- It does not yet create standalone movie entries or send new-episode announcements. A newly detected SxxExxx title is created as a drama record; poster/description can be completed in the MaseNet Admin Library.
- URL reachability is not guaranteed by parsing. Confirm that the provider URL works before applying it; the message-expiry notice alone is not a URL-expiry signal.
- Deploy only after code review and tests. Register the webhook only after the preview deployment is ready.
