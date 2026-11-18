# MaseNet Stream Manager Bot setup

This bot is separate from @MaseTv_Bot. It is restricted to the configured admin Telegram account and proposes catalogue changes for explicit approval.

## Production deployment

The Stream Manager uses the existing production MaseNet D1 database and the existing Cloudflare Pages Production environment. It does not use a separate Preview database.

Production already contains the required secret names:

- `MASE_STREAM_BOT_TOKEN`: token for @MaseNetStreamManagerBot.
- `MASE_STREAM_BOT_WEBHOOK_SECRET`: the dedicated webhook secret for this bot.
- `ADMIN_TELEGRAM_CHAT_ID`: the existing numeric admin Telegram user/chat ID.

The values are masked by Cloudflare and must never be copied into GitHub or chat. Do not rotate these secrets as part of deployment. The Production `DB` binding must remain the existing live MaseNet D1 database.

## Register the production webhook

After the code is merged and the Production deployment is successful, register the bot webhook to:

`https://masetv-cloudflare-migration.pages.dev/api/telegram/stream-manager`

Use the dedicated Stream Manager bot token and webhook secret, not the credentials for @MaseTv_Bot. Telegram supports setting a webhook with the `secret_token` field; the endpoint validates the matching `X-Telegram-Bot-Api-Secret-Token` header. Do not put the token or secret in GitHub, screenshots, or chat.

Do not change the webhook for @MaseTv_Bot. The new bot must remain independent.

## Current workflow

1. Admin forwards a generated HTTPS stream URL to the new bot.
2. Bot parses movie or drama title/year/season/episode/quality/codec/format metadata and stores a private pending record. Standalone movies use the existing movie title record with one playable Full Movie entry.
3. Bot looks for an exact normalized title match.
4. Admin explicitly presses Apply or Ignore.
5. Apply creates a new movie/drama title, adds a missing drama episode, adds or replaces a movie stream, replaces a matching quality+codec stream, or adds another quality/codec variant.
6. A pending submission must be claimed atomically so repeated or concurrent callback taps cannot apply it twice.

The five-minute notice from KDLAirBot is treated as the lifetime of its Telegram message only. It does not mean the video URL expires. The bot must preserve the URL and test reachability separately where possible.

## Current implementation limits

- The parser supports standalone movie filenames and drama episode filenames containing SxxExxx, with MKV/MP4/M4V/WEBM formats. Movie filenames should include a recognisable title; year, resolution and common codec/release tags are stripped from the detected title.
- It does not press buttons in KDLAirBot, request new links from KDLAirBot, or download video files.
- New movie/drama titles and new drama episodes use the existing MaseNet Telegram announcement helper. Stream replacements and additional quality/codec variants do not send duplicate new-title/episode announcements. Poster and description can be completed later in the MaseNet Admin Library.
- URL reachability is not guaranteed by parsing. A protected or expiring provider URL may reject HEAD/Range checks; no universal reachability guarantee should be shown.
- Do not merge or release changes until movie parsing, duplicate matching, movie stream replacement, drama episode handling, notification behavior, concurrency, and catalogue-preservation checks pass.
