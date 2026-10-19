export type CarpoolCoordinates = { latitude: number; longitude: number; label?: string };
export type CarpoolGeocodeBias = { latitude: number; longitude: number };
export type CarpoolGeocodeTransport = { id: string; resolve(address: string, bias?: CarpoolGeocodeBias): Promise<CarpoolCoordinates | null> };

export function normalizeCarpoolAddress(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function carpoolAddressNeedsLocality(value: string) {
  const address = value.trim();
  if (!address) return false;
  const hasPostalCode = /\b\d{5}(?:-\d{4})?\b/.test(address);
  const hasStateCode = /(?:^|[\s,])(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)(?:[\s,]|$)/i.test(address);
  const hasStreetCityStateShape = address.split(",").filter((part) => part.trim()).length >= 3;
  return !hasPostalCode && !hasStateCode && !hasStreetCityStateShape;
}

export function carpoolLocationCacheKey(provider: string, address: string, bias?: CarpoolGeocodeBias) {
  const context = bias ? `:proximity=${bias.longitude.toFixed(2)},${bias.latitude.toFixed(2)}` : "";
  return `${provider}:v1:country=us${context}:${normalizeCarpoolAddress(address)}`;
}

/** Deterministic test transport. Production code must inject an approved provider. */
export class SyntheticCarpoolGeocoder implements CarpoolGeocodeTransport {
  readonly id = "synthetic";
  calls = 0; private readonly misses: readonly string[];
  constructor(misses: readonly string[] = []) { this.misses = misses; }
  async resolve(address: string, bias?: CarpoolGeocodeBias): Promise<CarpoolCoordinates | null> {
    this.calls += 1;
    if (this.misses.some((item) => normalizeCarpoolAddress(item) === normalizeCarpoolAddress(address))) return null;
    let hash = 2166136261;
    for (const character of normalizeCarpoolAddress(address)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    const positive = hash >>> 0;
    return { latitude: 39.85 + (positive % 3000) / 10000, longitude: -75.35 + (Math.floor(positive / 3000) % 3000) / 10000, label: address.trim() };
  }
}

export class GeoapifyCarpoolGeocoder implements CarpoolGeocodeTransport {
  readonly id = "geoapify";
  private readonly apiKey: string;
  private readonly request: typeof fetch;
  constructor(apiKey: string, request: typeof fetch = globalThis.fetch) { this.apiKey = apiKey; this.request = request.bind(globalThis); }
  async resolve(address: string, bias?: CarpoolGeocodeBias): Promise<CarpoolCoordinates | null> {
    if (!this.apiKey.trim()) throw new Error("Carpool automatic lookup is not configured.");
    const url = new URL("https://api.geoapify.com/v1/geocode/search");
    url.searchParams.set("text", address);
    url.searchParams.set("filter", "countrycode:us");
    url.searchParams.set("limit", "1");
    url.searchParams.set("format", "json");
    if (bias) url.searchParams.set("bias", `proximity:${bias.longitude},${bias.latitude}`);
    url.searchParams.set("apiKey", this.apiKey);
    let response: Response;
    try { response = await this.request(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) }); }
    catch { throw new Error("The location provider could not be reached. Check this installation's network access and try again."); }
    if (response.status === 429) throw new Error("The location provider rate limit was reached. Wait a moment and resume the lookup.");
    if (!response.ok) throw new Error(`The location provider returned ${response.status}. Check the Carpool provider configuration.`);
    const payload = await response.json() as { results?: Array<{ lat?: number; lon?: number; formatted?: string }> };
    const result = payload.results?.[0];
    if (!result || typeof result.lat !== "number" || typeof result.lon !== "number" || !Number.isFinite(result.lat) || !Number.isFinite(result.lon)) return null;
    return { latitude: result.lat, longitude: result.lon, label: result.formatted };
  }
}
