import { Env, json, requireAdmin } from "./auth/_shared";

type HeroSettings = {
  featuredTitleId: string; titleOverride: string; descriptionOverride: string; backgroundImageUrl: string;
  eyebrow: string; primaryButtonLabel: string; secondaryButtonLabel: string; showTitleTags: boolean; showHero: boolean;
};
const defaults: HeroSettings = {
  featuredTitleId: "", titleOverride: "", descriptionOverride: "", backgroundImageUrl: "",
  eyebrow: "✦ EXCLUSIVE", primaryButtonLabel: "Watch Now", secondaryButtonLabel: "＋ My List",
  showTitleTags: true, showHero: true
};
function clean(input: unknown): HeroSettings {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const text = (key: string, max: number, fallback: string) => typeof value[key] === "string" ? String(value[key]).trim().slice(0, max) : fallback;
  const image = text("backgroundImageUrl", 2048, defaults.backgroundImageUrl);
  return {
    featuredTitleId: text("featuredTitleId", 160, defaults.featuredTitleId),
    titleOverride: text("titleOverride", 100, defaults.titleOverride),
    descriptionOverride: text("descriptionOverride", 500, defaults.descriptionOverride),
    backgroundImageUrl: /^https:\/\//i.test(image) ? image : "",
    eyebrow: text("eyebrow", 50, defaults.eyebrow),
    primaryButtonLabel: text("primaryButtonLabel", 24, defaults.primaryButtonLabel),
    secondaryButtonLabel: text("secondaryButtonLabel", 24, defaults.secondaryButtonLabel),
    showTitleTags: typeof value.showTitleTags === "boolean" ? value.showTitleTags : defaults.showTitleTags,
    showHero: typeof value.showHero === "boolean" ? value.showHero : defaults.showHero
  };
}
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const row = await env.DB.prepare("SELECT value_json FROM site_settings WHERE key='hero_settings'").first<{value_json:string}>();
  let settings = defaults;
  try { if (row?.value_json) settings = { ...defaults, ...clean(JSON.parse(row.value_json)) }; } catch {}
  return json({ settings });
};
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({})) as { settings?: unknown };
  if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings))
    return json({ error: "Provide valid hero settings." }, 400);
  const previous = await env.DB.prepare("SELECT value_json FROM site_settings WHERE key='hero_settings'").first<{value_json:string}>();
  let existing = defaults;
  try { if (previous?.value_json) existing = { ...defaults, ...clean(JSON.parse(previous.value_json)) }; } catch {}
  const raw = body.settings as Record<string, unknown>;
  const settings = clean({ ...existing, ...raw });
  const image = String(raw.backgroundImageUrl || "").trim();
  if (image && !/^https:\/\//i.test(image)) return json({ error: "Background image URL must start with https://." }, 400);
  await env.DB.prepare("INSERT INTO site_settings(key,value_json,updated_at) VALUES('hero_settings',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=datetime('now')")
    .bind(JSON.stringify(settings)).run();
  return json({ ok: true, settings });
};
