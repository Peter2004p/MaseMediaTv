import { json, type Env } from "./auth/_shared";

type Coordinates = { latitude?: unknown; longitude?: unknown };
type GeoContext = { latitude?: string; longitude?: string; city?: string; region?: string; country?: string };

const finiteCoordinate = (value: unknown, min: number, max: number): number | null => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
};

async function fetchJson(url: string, timeoutMs = 7000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" }, cf: { cacheTtl: 0, cacheEverything: false } } as RequestInit);
    if (!response.ok) throw new Error("Weather service returned " + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export const onRequestPost: PagesFunction<Env> = async ({ request }) => {
  let body: Coordinates = {};
  try {
    const raw = await request.text();
    if (raw.length > 1024) return json({ error: "Invalid location request." }, 413);
    body = raw ? JSON.parse(raw) as Coordinates : {};
  } catch {
    return json({ error: "Invalid location request." }, 400);
  }

  let latitude = finiteCoordinate(body.latitude, -90, 90);
  let longitude = finiteCoordinate(body.longitude, -180, 180);
  let locationSource: "device" | "approximate" = latitude !== null && longitude !== null ? "device" : "approximate";

  if (latitude === null || longitude === null) {
    const cf = (request as Request & { cf?: GeoContext }).cf;
    latitude = finiteCoordinate(cf?.latitude, -90, 90);
    longitude = finiteCoordinate(cf?.longitude, -180, 180);
  }

  if (latitude === null || longitude === null) {
    try {
      const approximate = await fetchJson("https://ipapi.co/json/", 5000);
      latitude = finiteCoordinate(approximate?.latitude, -90, 90);
      longitude = finiteCoordinate(approximate?.longitude, -180, 180);
    } catch {
      return json({ error: "Could not determine an approximate location. Allow location access and try again." }, 503);
    }
  }

  if (latitude === null || longitude === null) {
    return json({ error: "Weather location is unavailable. Allow device location and try again." }, 503);
  }

  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + latitude +
      "&longitude=" + longitude +
      "&current=temperature_2m,weather_code&timezone=auto";
    const weather = await fetchJson(url, 7000);
    const code = Number(weather?.current?.weather_code);
    const temperature = Number(weather?.current?.temperature_2m);
    if (!Number.isFinite(code) || !Number.isFinite(temperature)) {
      return json({ error: "The weather service returned incomplete data. Please try again." }, 502);
    }

    let theme: "ocean" | "sunset" | "midnight" | "emerald";
    if (code >= 95 || (code >= 51 && code <= 82)) theme = "ocean";
    else if (code === 0 || code === 1) theme = temperature >= 30 ? "sunset" : "emerald";
    else if (code === 2 || code === 3 || code === 45 || code === 48) theme = "midnight";
    else if (temperature >= 30) theme = "sunset";
    else if (temperature <= 18) theme = "midnight";
    else theme = "emerald";

    return json({ theme, temperature, locationSource });
  } catch (error) {
    console.error("MaseNet weather lookup failed:", error instanceof Error ? error.message : "unknown error");
    return json({ error: "Weather data is temporarily unavailable. Please check your connection and try again." }, 503);
  }
};
