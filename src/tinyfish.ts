export interface TinyFishConfig {
  endpoint: string;
  apiKey?: string;
  limit: number;
}

export interface TinyFishSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  publishedAt?: string;
  source?: string;
  [key: string]: unknown;
}

export interface TinyFishSearchResponse {
  query: string;
  results: TinyFishSearchResult[];
}

const FRESHNESS_PATTERNS = [
  /\b(search|look)\s+(for|up)\b/i,
  /\b(web\s+search|browse|google|verify|fact[- ]?check)\b/i,
  /\b(source|sources|cite|citation|with\s+links?)\b/i,
  /\b(outdated|stale|old\s+answer|not\s+up[- ]?to[- ]?date)\b/i,
  /\b(latest|newest|current|recent|today'?s|breaking|news)\b/i,
  /\b(up[- ]?to[- ]?date|current\s+status|latest\s+status)\b/i,
  /\b(latest|current|newest|recent)\s+(price|pricing|cost|release|version|model|api|docs?|documentation|status)\b/i,
  /\b(price|pricing|cost|release|version|model|api|docs?|documentation|status)\s+(today|currently|right\s+now|now)\b/i,
  /\b(what|who|when|where|which|is|are|has|have)\b.{0,60}\b(right\s+now|currently|today)\b/i
];

export function getTinyFishConfig(): TinyFishConfig {
  return {
    endpoint: process.env.TINYFISH_ENDPOINT ?? "https://api.search.tinyfish.ai",
    apiKey: process.env.TINYFISH_API_KEY,
    limit: Number(process.env.TINYFISH_SEARCH_LIMIT ?? 5)
  };
}

export function isTinyFishConfigured(config = getTinyFishConfig()): boolean {
  return Boolean(config.apiKey);
}

export function needsFreshSearch(text: string): boolean {
  return FRESHNESS_PATTERNS.some((pattern) => pattern.test(text));
}

export async function searchTinyFish(query: string, config = getTinyFishConfig()): Promise<TinyFishSearchResponse> {
  if (!isTinyFishConfigured(config)) {
    throw new Error("TinyFish is not configured. Set TINYFISH_API_KEY.");
  }

  const url = new URL(config.endpoint);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(config.limit));

  const response = await fetch(url, {
    headers: {
      "X-API-Key": config.apiKey ?? ""
    }
  });

  if (!response.ok) {
    throw new Error(`TinyFish request failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { results?: TinyFishSearchResult[] };
  return {
    query,
    results: Array.isArray(payload.results) ? payload.results.slice(0, config.limit) : []
  };
}
