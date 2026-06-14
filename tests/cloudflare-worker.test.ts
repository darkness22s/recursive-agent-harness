import { describe, expect, it } from "vitest";
import cloudWorker from "../src/cloudflare-worker.js";

class MemoryKv {
  private readonly values = new Map<string, string>();

  async get<T>(key: string, type?: "json"): Promise<T | string | null> {
    const value = this.values.get(key);
    if (!value) {
      return null;
    }
    return type === "json" ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function env() {
  return {
    HARNESS_STATE: new MemoryKv() as unknown as KVNamespace,
    RECURSIVE_HARNESS_API_KEY: undefined,
    OLLAMA_HOST: "https://ollama.com",
    RECURSIVE_HARNESS_MODEL: "gemma4:31b"
  };
}

describe("Cloudflare Worker control plane", () => {
  it("serves dashboard, records local worker state, and writes scheduled summaries", async () => {
    const testEnv = env();

    const dashboard = await cloudWorker.fetch(new Request("https://example.com/?range=24h"), testEnv);
    expect(await dashboard.text()).toContain("Recursive Harness Cloud");

    const heartbeat = await cloudWorker.fetch(new Request("https://example.com/v1/local-workers/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "pc-1", name: "Lenovo PC", capabilities: ["powershell"] })
    }), testEnv);
    expect(heartbeat.status).toBe(200);

    const taskResponse = await cloudWorker.fetch(new Request("https://example.com/v1/local-workers/pc-1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "Write-Output hello", shell: "powershell" })
    }), testEnv);
    const task = await taskResponse.json() as { id: string; status: string };
    expect(task.status).toBe("queued");

    const pending: Promise<unknown>[] = [];
    await cloudWorker.scheduled({} as ScheduledEvent, testEnv, {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => undefined,
      props: {}
    } as unknown as ExecutionContext);
    await Promise.all(pending);

    const statusResponse = await cloudWorker.fetch(new Request("https://example.com/v1/status?range=7d"), testEnv);
    const status = await statusResponse.json() as { stats: { summaries: number; localTasksQueued: number; localWorkersOnline: number } };
    expect(status.stats.summaries).toBe(1);
    expect(status.stats.localTasksQueued).toBe(1);
    expect(status.stats.localWorkersOnline).toBe(1);
  });

  it("requires bearer auth when a runtime key is configured", async () => {
    const testEnv = {
      ...env(),
      RECURSIVE_HARNESS_API_KEY: "secret"
    };

    const rejected = await cloudWorker.fetch(new Request("https://example.com/v1/status"), testEnv);
    expect(rejected.status).toBe(401);

    const accepted = await cloudWorker.fetch(new Request("https://example.com/v1/status", {
      headers: { authorization: "Bearer secret" }
    }), testEnv);
    expect(accepted.status).toBe(200);
  });

  it("accepts steering messages and exposes public stream, lifecycle, and sandbox status", async () => {
    const testEnv = {
      ...env(),
      RECURSIVE_HARNESS_API_KEY: "secret"
    };
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer secret"
    };

    const lifecycle = await cloudWorker.fetch(new Request("https://example.com/v1/lifecycle", {
      method: "POST",
      headers,
      body: JSON.stringify({ phase: "developing" })
    }), testEnv);
    expect(lifecycle.status).toBe(200);

    const steer = await cloudWorker.fetch(new Request("https://example.com/v1/steer", {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "Queue a local cleanup task next." })
    }), testEnv);
    expect(steer.status).toBe(200);

    const streamResponse = await cloudWorker.fetch(new Request("https://example.com/v1/stream?range=24h", {
      headers: { authorization: "Bearer secret" }
    }), testEnv);
    const stream = await streamResponse.json() as { stream: Array<{ kind: string; detail: string }> };
    expect(stream.stream.some((item) => item.kind === "steering" && item.detail.includes("cleanup"))).toBe(true);

    const statusResponse = await cloudWorker.fetch(new Request("https://example.com/v1/status?range=24h", {
      headers: { authorization: "Bearer secret" }
    }), testEnv);
    const status = await statusResponse.json() as { phase: string; sandbox: { fullVm: boolean; cloud: string } };
    expect(status.phase).toBe("developing");
    expect(status.sandbox.fullVm).toBe(false);
    expect(status.sandbox.cloud).toContain("not a full VM");
  });

  it("uses TinyFish search and records results in the public stream", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("api.search.tinyfish.ai");
      return new Response(JSON.stringify({
        results: [
          { title: "Fresh result", url: "https://example.com/fresh", snippet: "Current data" }
        ]
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const testEnv = {
        ...env(),
        RECURSIVE_HARNESS_API_KEY: "secret",
        TINYFISH_API_KEY: "tinyfish-test-key"
      };
      const response = await cloudWorker.fetch(new Request("https://example.com/v1/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret"
        },
        body: JSON.stringify({ query: "latest recursive agent harness news" })
      }), testEnv);

      const search = await response.json() as { ok: boolean; results: Array<{ title: string }> };
      expect(search.ok).toBe(true);
      expect(search.results[0]?.title).toBe("Fresh result");

      const streamResponse = await cloudWorker.fetch(new Request("https://example.com/v1/stream?range=24h", {
        headers: { authorization: "Bearer secret" }
      }), testEnv);
      const stream = await streamResponse.json() as { stream: Array<{ kind: string; title: string }> };
      expect(stream.stream.some((item) => item.kind === "search" && item.title === "TinyFish search completed")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
