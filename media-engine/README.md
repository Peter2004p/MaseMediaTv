# MaseNet Dedicated Media Engine

An isolated Cloudflare Worker + Durable Object Container running FFmpeg/FFprobe. This is a separate service and does not replace the existing MaseNet player until integration and device tests pass.

## What this first engine slice provides

- FFprobe metadata for video, audio and subtitle streams.
- FFmpeg H.264/AAC HLS conversion for browser playback.
- WebVTT conversion for text subtitle streams.
- Per-session HLS playlist and segment serving.
- HTTPS-only source validation and private/local address rejection.
- Bearer-token protection at the Worker gateway.

Bitmap subtitle formats (PGS/VobSub) are detected but are not converted to text WebVTT by this initial implementation. Multi-audio HLS rendition switching, durable session storage, source-provider headers, and automatic session cleanup are follow-up work.

## Deploy separately

1. Install dependencies from this directory: `npm install`.
2. Set the Worker secret: `npx wrangler secret put MEDIA_ENGINE_TOKEN`.
3. Deploy: `npx wrangler deploy --config wrangler.toml`.
4. Keep the token private. The MaseNet Pages application must call this gateway only from a server-side Function after validating the episode against the D1 library. Never expose the token in browser JavaScript.
5. Container usage is billable. Confirm account billing/limits before deploying.

## API

All endpoints except gateway `GET /health` require `Authorization: Bearer <MEDIA_ENGINE_TOKEN>`.

- `GET /probe?url=<encoded-https-source>`
- `POST /sessions` JSON body: `{"url":"https://..."}`
- `GET /sessions/:id/index.m3u8` and generated segment URLs
- `GET /subtitle?url=<encoded-https-source>&stream=<ffprobe-stream-index>`

The Pages integration is intentionally not wired into the current player yet. It must first enforce the same D1 episode/source authorization as the existing media proxy, then map the engine session and subtitle endpoints to the selected episode.
