# MaseNet — Cloudflare Pages

MaseNet is deployed from the `cloudflare-migration` branch to the Cloudflare Pages project `masetv-cloudflare-migration`.

## Platform architecture

- **Frontend:** React, TypeScript and Vite.
- **Hosting:** Cloudflare Pages.
- **Backend:** Cloudflare Pages Functions.
- **Database:** Cloudflare D1.
- **Media assets:** Cloudflare R2 where configured.
- **AI:** website assistant and Telegram bot integrations using configured AI credentials.
- **Telegram:** bot webhook and Telegram Mini App authentication.

## Deployment

- Production site: https://masetv-cloudflare-migration.pages.dev
- Source branch: `cloudflare-migration`
- Build command: `npm run build`
- Output directory: `dist`

Cloudflare Pages deploys automatically when commits are pushed to the connected branch. A successful build/deployment confirms that the artifact was built and published; it does not by itself prove that every authenticated workflow, media source, Telegram action or device-specific layout works end to end.

## Quality checks

- `npm run build` — production frontend build.
- `npm run typecheck:functions` — TypeScript checks for Pages Functions.
- `npm run test:telegram-e2e` — live Telegram access-gate test. Run only with the dedicated test account and environment variables described in the script.

## Safety and operations

- Never commit bot tokens, API keys, OAuth secrets or webhook secrets.
- Do not reset production D1, administrator accounts, sessions or catalogue data during UI work.
- Do not remove a feature solely because it appears unused. Confirm its route, API dependencies and persisted data before deprecating it.
- Keep the AppDeploy source backup branch intact; it is a historical reference, not the active deployment target.
