# MaseTv AppDeploy source snapshot

Source snapshot exported from deployed AppDeploy project `masetv-jjkwcm` on 2026-10-17.

- Live website: https://masetv-jjkwcm.v2.appdeploy.ai/
- Frontend: React + Vite + TypeScript
- Backend: AppDeploy SDK routes and services
- Build: `npm install` then `npm run build`

## Important

This is a source-code backup, not an automatic migration or deployment to GitHub Pages/Cloudflare. The backend imports `@appdeploy/sdk` and uses AppDeploy-managed database, storage, authentication, AI and secrets; those services and secret values are not exported by this source copy. Configure replacement services and environment bindings before hosting it outside AppDeploy.

Do not commit API keys, bot tokens, passwords, session secrets, or user media. User-uploaded media and AppDeploy database records are not included in this code snapshot.
