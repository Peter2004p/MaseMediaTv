# MaseTv / MaseNet

Mobile-first streaming catalog and admin workspace for the MaseTv project.

## Open the project
- Public homepage: [index.html](./index.html)
- Admin workspace: [admin.html](./admin.html)
- Cloudflare Pages Functions: [functions/api](./functions/api)
- Original AppDeploy source snapshot: [appdeploy-source](./appdeploy-source)

## Current homepage
The homepage includes a responsive cinematic layout, search, catalog filters, movie/drama shelves, title detail dialog, watchlist saved on the current device, Reels shelf, and a floating channel button. It requests public catalog metadata from `GET /api/catalog` and uses clearly illustrative demo titles if the API is unavailable.

The public API intentionally excludes streaming and subtitle source URLs. The detail player can play a source only when an authorized URL is supplied to the client; private source delivery must be designed and protected server-side before production.

## Backend and admin status
The repository includes Cloudflare Pages Functions for public catalog reads and admin login/session scaffolding, plus protected import and catalog mutation routes. The admin page is still a safe-preview workspace; do not treat every panel as a production feature. Admin login currently assumes SHA-256(password + salt). Verify the existing admin password provisioning formula before enabling writes. Rate limiting, expired-session cleanup, automated security tests, and a verified upload-storage pipeline are still required.

Reels upload and persistent media storage are not yet implemented. The Reels shelf on the homepage is a placeholder, not an upload-backed feed. Normal and automatic bulk URL tools must be tested against the deployed API and real catalog schema before production use.

## Cloudflare setup
Deploy this repository as a **separate preview Pages project first**. Configure the D1 binding named `DB` for the correct database and verify schema compatibility. Do not attach this repository to the existing production site until login, session cookies, catalog queries, and protected mutations have been tested. Never place credentials, admin passwords, API tokens, or bot tokens in this repository.

This repository commit updates GitHub source only; it does not deploy the site or modify the existing Cloudflare production project.

## Media and rights
Only upload or link to videos, subtitles, posters, and downloads you own or have permission to distribute. Use HTTPS sources. Do not treat demo catalog entries as actual available movies.
