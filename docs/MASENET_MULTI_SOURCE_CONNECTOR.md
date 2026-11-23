# MaseNet Multi-Source Episode Connector

Status: architecture proposal; no provider integration is enabled.

## Goal

Let MaseNet discover titles and episode availability from multiple approved providers without storing or proxying their media files. Keep the existing MaseNet catalogue and player as the user-facing experience.

## Non-negotiable source policy

A provider may be imported into MaseNet only when all of the following are true:

1. The provider documents an API/feed or grants written permission for the integration.
2. The permission covers the intended use: search, metadata, episode links, embedding, territories, caching, and any commercial use that applies.
3. Each returned item has a stable provider ID, title/episode identity, source URL, and permitted playback mode.
4. The provider's terms allow the intended request frequency and caching behavior.

If any item is not established, MaseNet may show a clearly labelled external provider page link where permitted, but must not extract hidden media URLs, replay private API calls, defeat access controls, or import the stream into the MaseNet player.

## Architecture

```text
MaseNet search / title page
        |
        v
Pages Function: /api/sources/search
        |
        +--> MaseNet catalogue (existing D1)
        |
        +--> Provider adapter registry
                 |
                 +--> Official/licensed API adapter
                 +--> Approved partner feed adapter
                 +--> External-page link adapter (no stream extraction)
        |
        v
Normalized source results
        |
        +--> Authorized embeddable stream -> MaseNet player
        |
        +--> External-only page -> open provider page
```

Provider adapters run server-side. Provider credentials, if any, belong in server-side secrets and must never be shipped to the browser.

## Normalized result contract

Each adapter returns a list using this shape:

- `providerId`: stable internal provider key
- `providerTitleId`: provider's stable title identifier, if supplied
- `title`: display title
- `season`: integer or null
- `episode`: integer or null
- `episodeTitle`: string or null
- `language`: language tag or null
- `quality`: provider-reported quality or null
- `playbackMode`: `external` or `embed`
- `pageUrl`: canonical HTTPS page on the provider's approved hostname
- `streamUrl`: present only when the provider explicitly authorizes direct embedding/reuse
- `subtitleTracks`: provider-authorized subtitle metadata; never infer tracks from an inaccessible media file
- `checkedAt`: ISO timestamp
- `expiresAt`: timestamp if the provider documents URL expiry
- `rightsProfile`: server-side permission profile used to decide which fields/actions may be exposed

Do not treat a provider's own disclaimer, a working URL, or the fact that MaseNet does not host files as proof of redistribution or embedding permission.

## API shape

### Search

`POST /api/sources/search`

Request:
```json
{ "query": "Blossom in Darkness", "season": 1, "episode": 1 }
```

Response:
```json
{
  "ok": true,
  "results": [
    {
      "providerId": "approved-provider-key",
      "title": "Blossom in Darkness",
      "season": 1,
      "episode": 1,
      "playbackMode": "external",
      "pageUrl": "https://provider.example/title/episode",
      "checkedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

The example hostname and timestamp above are illustrative only, not a real provider endpoint or approved host.

### Provider health

A separate admin-only health view should report adapter status, last successful sync, rate-limit state, and provider errors. It must not expose API credentials.

## Matching and duplicate prevention

1. Prefer provider IDs when available.
2. Otherwise match normalized title plus season and episode; retain the original title for display.
3. Never match by title alone when attaching an episode URL.
4. Preserve multiple providers as separate source options rather than overwriting the current catalogue URL.
5. Record source, checked time, playback mode, and rights profile for audit.
6. Mark expired/unreachable sources unavailable; do not silently substitute another provider's link.

## URL and network safety

- HTTPS only.
- Exact hostname allowlist per provider.
- Reject IP literals, localhost, private/special-use addresses, non-standard ports, credentials in URLs, and redirects to unapproved hosts.
- Prevent server-side request forgery; adapters may call only fixed provider API origins configured by administrators.
- Apply per-provider timeouts, response-size limits, rate limits, and caching within the provider's permitted terms.
- Treat all provider responses as untrusted data and validate every field.

## Player behavior

- `external`: show an "Open on [provider]" action and do not pass the URL to the MaseNet video player.
- `embed`: pass only the explicitly authorized stream URL to the player.
- Subtitle tracks appear only when the provider supplies authorized subtitle URLs or the authorized media format exposes selectable tracks in the browser. MKV embedded subtitle support is not guaranteed by browsers; do not promise VLC-equivalent playback for arbitrary MKV links.
- Keep source selection visible so users know which provider supplies the episode.

## OmniSave / VideoDownloader.site onboarding checklist

Before enabling an OmniSave adapter, obtain written answers to:

1. Is there a public or partner API/feed for third-party catalogue integrations?
2. May MaseNet display search results, titles, posters, season/episode metadata, and provider page links?
3. May MaseNet use direct media URLs in its own player, or must playback remain on OmniSave?
4. What territories, content categories, and commercial/non-commercial uses are permitted?
5. What authentication, rate limits, attribution, caching, takedown, and expiry rules apply?
6. Does the provider have authority to grant these permissions for each third-party source it indexes?

Do not infer that permission for OmniSave's own website extends to MaseNet.

## Rollout plan

1. Confirm provider API/feed and written permissions.
2. Implement a provider-specific server-side adapter against documented endpoints only.
3. Add schema validation, hostname/redirect restrictions, rate limits, and audit logging.
4. Test against a small set of provider-approved sample titles on Preview.
5. Verify mobile browser playback and subtitle behavior for each permitted playback mode.
6. Keep the adapter disabled until the provider-specific rights profile is approved.
7. Release to production only after separate explicit production approval.

## Current state

- No official OmniSave developer API documentation has been verified.
- No written permission for MaseNet's reuse of indexed third-party links has been verified.
- Therefore, no OmniSave scraper, hidden endpoint caller, direct-stream extractor, or automatic catalogue importer is enabled.
- This document changes no database rows, secrets, player behavior, or production deployment.
