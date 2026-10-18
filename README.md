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
