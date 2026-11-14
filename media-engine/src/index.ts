import { DurableObject } from "cloudflare:workers";

interface Env {
  MEDIA_ENGINE: DurableObjectNamespace<MediaEngineContainer>;
  MEDIA_ENGINE_TOKEN: string;
}

export class MediaEngineContainer extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (!this.ctx.container.running) {
      await this.ctx.container.start({
        image: this.ctx.container.images.base,
        instance: "standard-2",
        enableInternet: true
      });
    }
    return this.ctx.container.getTcpPort(8080).fetch(request);
  }
}

function unauthorized() {
  return Response.json({ error: "Unauthorized media engine request" }, { status: 401 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "MaseNet Media Engine Gateway" });
    }
    const supplied = request.headers.get("authorization") || "";
    if (!env.MEDIA_ENGINE_TOKEN || supplied !== "Bearer " + env.MEDIA_ENGINE_TOKEN) return unauthorized();
    if (!["/probe", "/subtitle", "/sessions"].includes(url.pathname) && !url.pathname.startsWith("/sessions/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const id = env.MEDIA_ENGINE.idFromName("masenet-media-engine-primary");
    const stub = env.MEDIA_ENGINE.get(id);
    return stub.fetch(request);
  }
};
