# Preview isolation

The Cloudflare Pages preview environment must bind `DB` to the isolated `masenet-asian-discovery-preview` D1 database (`783e9c3d-b758-4273-9999-b6fffc6b560c`). The production environment continues to bind to the existing production D1 database. Never change production bindings as part of preview verification.

The discovery Worker also binds only to the isolated preview D1 database. Production publishing, Telegram webhook changes, and production secrets are intentionally out of scope until preview verification is complete.

The Pages `wrangler.toml` uses a top-level production D1 binding and an explicit `[env.preview]` D1 override. Cloudflare Pages applies `env.preview` to all preview deployments; this is not branch-specific. The production branch retains its unchanged top-level production binding.
