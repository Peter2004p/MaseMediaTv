# MaseNet Asian Content Discovery — Preview Worker

This isolated Cloudflare Worker is a staging implementation for Asian public-domain / Creative Commons video discovery.

## Safety boundary
- The Worker is deployed as `masenet-asian-discovery-preview` and binds only to the isolated preview D1 database `masenet-asian-discovery-preview`.
- It does not use the production MaseNet D1 database, production R2 bucket, or Telegram bot credentials.
- It does not scrape Viki, KBS, JFF Theater, YouTube, or any paid/licensed streaming player.
- It only auto-publishes records when source metadata explicitly declares Public Domain, CC0, CC BY, or CC BY-SA, and a direct MP4/WebM/OGG file passes a HEAD check.
- Non-commercial, No-Derivatives, unknown, missing, or unclear rights are not published; they remain in `needs_review`.
- The source API's licence declarations are uploader-supplied metadata, not a legal guarantee. A human rights audit is still required before production use.
- This first stage discovers eligible feature films and video works. It does not claim to source current Korean/Chinese/Japanese/Thai TV drama episodes; those require direct distributor/creator permissions and feeds.

## Sources
- Internet Archive Advanced Search + item metadata.
- Wikimedia Commons MediaWiki API + file extmetadata.

## Preview schedule
Runs every six hours at minute 15 UTC. Preview-only schedule.

## Endpoints
- `GET /health`
- `GET /status`

## D1
Apply `migrations/0001_init.sql` to the isolated preview D1 database before enabling the schedule.
