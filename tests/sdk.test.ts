import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  RecursiveHarness,
  RecursiveRuntime,
  getOllamaModelConfig,
  isOllamaConfigured,
  needsFreshSearch
} from "../src/index.js";

const config = {
  appId: "test-app",
  runtimeUrl: "local" as const,
  apiKey: "dev",
  optimization: "retention" as const,
  autonomy: "full" as const
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RecursiveHarness SDK", () => {
  it("defaults Ollama Cloud generation to Gemma 4", () => {
    const model = process.env.RECURSIVE_HARNESS_MODEL;
    const key = process.env.OLLAMA_API_KEY;
    delete process.env.RECURSIVE_HARNESS_MODEL;
    delete process.env.OLLAMA_API_KEY;

    expect(getOllamaModelConfig().model).toBe("gemma4:31b");
    expect(getOllamaModelConfig().host).toBe("https://ollama.com");
    expect(isOllamaConfigured()).toBe(false);

    if (model) {
      process.env.RECURSIVE_HARNESS_MODEL = model;
    }
    if (key) {
      process.env.OLLAMA_API_KEY = key;
    }
  });

  it("wires a host tool and executes it through the local runtime", async () => {
    const harness = RecursiveHarness.create(config);

    harness.registerTool({
      name: "createProject",
      description: "Creates a project",
      inputSchema: z.object({ name: z.string() }),
      execute: (input, context) => ({ id: "project_1", name: input.name, owner: context.userId })
    });

    const result = await harness.run({
      userId: "user_1",
      sessionId: "session_1",
      input: "createProject 'Apollo'"
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.ok).toBe(true);
    expect(result.output).toContain("Done");
  });

  it("detects profanity and anger in user experience traces", () => {
    const harness = RecursiveHarness.create(config);

    expect(harness.detectProfanity("what the f*ck happened")).toBe(true);
    expect(harness.detectAnger("this is useless!!")).toBe(true);
  });

  it("routes current-data requests through the built-in TinyFish search tool", async () => {
    const tinyfishKey = process.env.TINYFISH_API_KEY;
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.TINYFISH_API_KEY = "test-tinyfish-key";
    delete process.env.OLLAMA_API_KEY;

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Ollama Cloud model update",
              url: "https://example.com/ollama",
              snippet: "Gemma 4 is available through Ollama Cloud."
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const harness = RecursiveHarness.create(config);
    const result = await harness.run({
      userId: "user_1",
      sessionId: "session_1",
      input: "What is the latest Ollama Cloud Gemma 4 API status today?"
    });

    expect(needsFreshSearch("latest pricing today")).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.toolCalls[0]?.name).toBe("tinyfishSearch");
    expect(result.toolCalls[0]?.ok).toBe(true);
    expect(result.toolCalls[0]?.output).toMatchObject({
      query: "What is the latest Ollama Cloud Gemma 4 API status today?"
    });

    if (tinyfishKey) {
      process.env.TINYFISH_API_KEY = tinyfishKey;
    } else {
      delete process.env.TINYFISH_API_KEY;
    }
    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    }
  });
});

describe("RecursiveRuntime successor loop", () => {
  it("generates and promotes a successor runtime image from retention evidence", () => {
    const runtime = new RecursiveRuntime();
    const activeBefore = runtime.store.activeImage();

    for (const [index, message] of ["worked", "thanks", "nice recovery", "keep going"].entries()) {
      runtime.trackExperience(config, {
        userId: `user_${index}`,
        sessionId: `session_${index}`,
        message,
        response: "Done",
        outcome: "continued"
      });
    }

    const tick = runtime.tick();
    const activeAfter = runtime.store.activeImage();

    expect(tick.report.passed).toBe(true);
    expect(tick.promotion.action).toBe("promoted");
    expect(activeAfter.id).not.toBe(activeBefore.id);
    expect(activeAfter.parentId).toBe(activeBefore.id);
    expect(activeAfter.artifact.kind).toBe("runtime-image");
    expect(activeAfter.artifact.imageRef).toContain(`${activeAfter.version}`);
  });

  it("rejects promotion when there is not enough evidence", () => {
    const runtime = new RecursiveRuntime();

    runtime.trackExperience(config, {
      userId: "user_1",
      sessionId: "session_1",
      message: "ok",
      response: "ok",
      outcome: "continued"
    });

    const tick = runtime.tick();

    expect(tick.report.passed).toBe(false);
    expect(tick.promotion.action).toBe("rejected");
  });

  it("rolls back a promoted runtime when recent score degrades past threshold", () => {
    const runtime = new RecursiveRuntime();

    for (const [index, message] of ["worked", "thanks", "nice recovery", "keep going"].entries()) {
      runtime.trackExperience(config, {
        userId: `user_${index}`,
        sessionId: `session_${index}`,
        message,
        response: "Done",
        outcome: "continued"
      });
    }

    const original = runtime.store.activeImage();
    runtime.tick();
    const promoted = runtime.store.activeImage();
    const rollback = runtime.rollbackIfNeeded(0.1);

    expect(promoted.id).not.toBe(original.id);
    expect(rollback?.action).toBe("rolled_back");
    expect(runtime.store.activeImage().id).toBe(original.id);
  });
});
