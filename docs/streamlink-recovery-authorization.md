# MaseNet streamlink recovery authorization

The recovery pipeline is fail-closed. A working Telegram session or a reachable HTTPS URL is not evidence that a stream may be redistributed.

## Current defaults

- KDL Air retrieval is disabled unless `KDL_AIR_REDISTRIBUTION_AUTHORIZED=true` and a non-empty `KDL_AIR_REDISTRIBUTION_AUTHORIZATION_REFERENCE` are explicitly supplied to the runner.
- The authorization reference must point to real, reviewable permission or licence evidence. A text value alone does not grant rights.
- The recovery API independently requires `STREAMLINK_RECOVERY_ALLOWED_HOSTS` before it will write any replacement URL.
- The host allowlist is a comma-separated list of exact hostnames. Wildcards and suffix matching are not supported.
- Movie retrieval remains disabled. The current Telegram selection workflow is drama/episode-only.
- A replacement must still match the exact title, season, episode, quality, codec, and release tag where known. Compare-and-swap and recovery history remain mandatory.

## Before enabling a source

1. Confirm the source owner has granted MaseNet permission to generate, publish, and stream the relevant media links. Confirm territory, duration, monetization, attribution, and any other licence conditions.
2. Store the evidence reference in a controlled record. Do not use a guess, a traffic capture, or the fact that a bot returned a URL as evidence of rights.
3. Identify the exact hostname(s) used by authorized replacement URLs. Add only those exact hostnames to `STREAMLINK_RECOVERY_ALLOWED_HOSTS` in the isolated Cloudflare Pages Preview environment.
4. Only then may an operator configure the KDL authorization variables in the Preview workflow environment. Keep Production variables unset until a separate release review and explicit approval.
5. Verify playback and the recovery audit entry in Preview before considering any release.

## Safety rule

If permission, host identity, episode identity, or stream validity is uncertain, retain the old catalogue URL and report the item for manual review. Never delete catalogue rows or silently substitute another episode or quality.
