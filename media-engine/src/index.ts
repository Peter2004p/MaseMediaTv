import { DurableObject } from "cloudflare:workers";

interface Env {
  MEDIA_ENGINE: DurableObjectNamespace<MediaEngineContainer>;
  MEDIA_ENGINE_TOKEN: string;
}

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class MediaEngineContainer extends DurableObject<Env> {
  private starting: Promise<void> | undefined;

  async fetch(request: Request): Promise<Response> {
    this.starting ??= this.startAndWaitForPort().finally(() => {
      this.starting = undefined;
    });
    await this.starting;

    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    return this.ctx.container!.getTcpPort(PORT).fetch(forwarded);
  }

  private async startAndWaitForPort(): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error("MaseNet media container is not configured");
    if (!container.running) {
      container.start({
        image: container.images.base,
        instance: "standard-2",
        enableInternet: true
      });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await container.getTcpPort(PORT).fetch("http://container/health");
        if (response.ok) return;
        lastError = new Error("Media engine health returned HTTP " + response.status);
      } catch (error) {
        lastError = error;
      }
      await sleep(500);
    }
    throw new Error("MaseNet media engine did not become ready: " + String(lastError));
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
