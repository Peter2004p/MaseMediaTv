# MaseNet / Mase Media TV

Cloudflare migration branch for the MaseNet entertainment catalog and admin studio.

## Current status

- This branch is a migration and preview build; it is not yet the full production streaming application.
- The public catalog and separate normal/automatic bulk URL import workflows are wired to Cloudflare Pages Functions.
- Admin login still requires verification against the original password provisioning logic before production use.
- Playback delivery, real file uploads, Telegram delivery, homepage settings, and other studio sections remain incomplete.
- Never apply the draft additive migration to the production D1 database without a reviewed migration and rollback plan.

## Safety

- Keep admin passwords, API tokens, Telegram bot tokens, and other credentials out of Git.
- Preview deployments should use a separate D1 database from production.
- Do not reset the existing production admin or catalog to test this branch.


## Browser player prototype

The `feature/mase-player-mkv-subtitles` branch includes a track-aware `movi-player` prototype and an integration into the catalog detail view.

- Prototype page: `/player-lab.html`
- The catalogue still resolves media through `/api/watch/:id`; the watch endpoint redirects to the stored HTTPS media URL.
- The browser player can handle more containers and embedded audio/subtitle tracks than a native `<video>` element, depending on the media codecs and browser/device capabilities.
- Remote streams need suitable CORS permissions and HTTP byte-range support for reliable seeking. The redirect does not bypass the source host's CORS policy.
- This is not VLC/libVLC and cannot guarantee playback of every stream. DRM, expiring URLs, authentication headers, unsupported codecs, and hosts that block browser access may still fail.
- The real user-provided stream has not yet been end-to-end tested. Keep this change in preview until tested against representative authorized media.
