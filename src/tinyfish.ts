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

const FRESHNESS_TERMS = [
  "current",
  "latest",
  "recent",
  "today",
  "now",
  "up to date",
  "up-to-date",
  "breaking",
  "news",
  "pricing",
  "price",
  "cost",
  "release",
  "version",
  "api",
  "docs",
  "source",
  "sources",
  "cite",
  "citation"
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
  const lower = text.toLowerCase();
  return FRESHNESS_TERMS.some((term) => lower.includes(term));
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
