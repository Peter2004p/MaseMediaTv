# MaseNet Telegram Media Vault — implementation blueprint

## Product direction
MaseNet moves from expiring third-party stream URLs to an owner-managed Telegram media library. Telegram stores the actual media messages; Cloudflare D1 stores catalogue metadata and private message references only. Cloudflare R2 remains for posters/artwork, not feature-length video.

## Bots and channels
- **@MaseNetStreamManagerBot** is the private ingest bot. Only the Telegram account configured as `ADMIN_TELEGRAM_CHAT_ID` can upload or manage assets.
- **Private vault channel** stores the copied original Telegram media messages. Configure `MASE_MEDIA_VAULT_CHAT_ID` to the private channel ID. Add both bots as channel administrators: the Stream Manager bot needs permission to post; @MaseTv_Bot needs permission to access/copy messages.
- **@MaseTv_Bot** is the public delivery bot. It must use its existing webhook, with a media-delivery handler integrated into the existing webhook (never replace its webhook with a second handler).
- The website shows metadata, trailers and episode/quality choices. It does not proxy video bytes.

## Ingest flow
1. Owner sends a video or document to @MaseNetStreamManagerBot.
2. Bot verifies the exact owner Telegram ID and private chat.
3. It copies the message into the private vault with Telegram `copyMessage`; it never downloads the video to Cloudflare.
4. It stores vault chat/message references, file unique ID, size, MIME/container and parsed title/year/season/episode/quality/codec/language in D1.
5. Every new asset starts as `staged`; it is not publicly discoverable or deliverable until reviewed, linked to a catalogue title and explicitly rights-confirmed.
6. Duplicate detection should use title ID + season + episode + quality + codec + file unique ID. Never silently overwrite a different file.

Suggested filename:
- Drama: `Title Name (2026) S01E02 1080p x265.mkv`
- Movie: `Title Name (2026) 1080p x265.mkv`
Caption overrides: `Title:`, `Type:`, `Language:`.

## Delivery design
- The website issues an opaque, short-lived, single-use download token for an approved asset.
- The website opens `https://t.me/MaseTv_Bot?start=dl_<token>`.
- Existing @MaseTv_Bot webhook validates the token, checks that the asset is published and rights-confirmed, then uses that bot's `copyMessage` from the private vault into the user's private chat.
- The public bot must be a member/admin of the vault channel. Use the stored channel ID and message ID; do not try to reuse the Stream Manager bot's `file_id` in the public bot.
- Rate-limit per Telegram user, expire tokens quickly, log delivery outcomes, and make tokens single-use. Do not expose vault channel IDs/message IDs or tokens in the website HTML.
- Delivery is Telegram chat delivery, not an unrestricted direct-download URL. Users need Telegram and must start the public bot first.

## Telegram limits and resilience
- Telegram cloud storage is not a contractual archival service or unlimited CDN. Preserve a catalogue backup and a manifest of vault references. Monitor bot API errors and keep an off-platform backup of media you own.
- Bot API upload/download limits differ from Telegram client uploads. This design avoids bot re-uploading the movie to Cloudflare: the manager bot copies the user's incoming Telegram message into the vault.
- Test large uploads on real devices and confirm channel permissions, message retention and delivery before publishing.
- Never use Telegram as a way to redistribute films without the necessary rights. The rights-confirmation flag must default to false.

## Current implementation status
- D1 migration adds the media-asset registry and expiring delivery-token table.
- Dedicated private ingest endpoint copies owner-submitted Telegram video/document messages into the vault and stages metadata.
- Webhook registration is separate from the legacy URL-based Stream Manager registration.
- Public delivery, title-page UI and trailer metadata are subsequent integration work; do not advertise those as live until tested.
- Preview only. No production webhook registration, D1 migration or deployment is performed by this code change.
