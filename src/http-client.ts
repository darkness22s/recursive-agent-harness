import type {
  AppSnapshot,
  ExperienceEvent,
  HarnessConfig,
  PromotionRecord,
  RunInput,
  RunResult,
  RuntimeImage,
  ToolManifest
} from "./types.js";

async function postJson<T>(runtimeUrl: string, path: string, apiKey: string, body: unknown): Promise<T> {
  const response = await fetch(`${runtimeUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Runtime request failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function getJson<T>(runtimeUrl: string, path: string, apiKey: string): Promise<T> {
  const response = await fetch(`${runtimeUrl}${path}`, {
    headers: {
      authorization: `Bearer ${apiKey}`
    }
  });
  if (!response.ok) {
    throw new Error(`Runtime request failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export class RuntimeHttpClient {
  constructor(private readonly config: HarnessConfig) {}

  registerToolManifest(manifest: ToolManifest): Promise<{ ok: true }> {
    return postJson(this.config.runtimeUrl, "/v1/tools", this.config.apiKey, {
      appId: this.config.appId,
      manifest
    });
  }

  run(input: RunInput): Promise<RunResult> {
    return postJson(this.config.runtimeUrl, "/v1/run", this.config.apiKey, {
      config: this.config,
      input
    });
  }

  trackExperience(event: ExperienceEvent): Promise<ExperienceEvent> {
    return postJson(this.config.runtimeUrl, "/v1/events", this.config.apiKey, {
      config: this.config,
      event
    });
  }

  snapshot(snapshot: AppSnapshot): Promise<AppSnapshot> {
    return postJson(this.config.runtimeUrl, "/v1/snapshots", this.config.apiKey, {
      snapshot
    });
  }

  getActiveSuccessor(): Promise<RuntimeImage> {
    return getJson(this.config.runtimeUrl, "/v1/successor/active", this.config.apiKey);
  }

  getPromotionHistory(): Promise<PromotionRecord[]> {
    return getJson(this.config.runtimeUrl, "/v1/successor/history", this.config.apiKey);
  }

  tickRecursion(): Promise<unknown> {
    return postJson(this.config.runtimeUrl, "/v1/recursion/tick", this.config.apiKey, {});
  }

  rollbackIfNeeded(recentScore: number): Promise<PromotionRecord | undefined> {
    return postJson(this.config.runtimeUrl, "/v1/recursion/rollback-check", this.config.apiKey, { recentScore });
  }
}
