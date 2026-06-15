import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "createProject", input: { name: "Apollo" } }) } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: "Created Apollo." } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
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
    expect(result.output).toBe("Created Apollo.");
    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("detects profanity and anger in user experience traces", () => {
    const harness = RecursiveHarness.create(config);

    expect(harness.detectProfanity("what the f*ck happened")).toBe(true);
    expect(harness.detectAnger("this is useless!!")).toBe(true);
  });

  it("calls Ollama and does not search or leak internals for normal consumer chat", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: { content: "What would you like to know?" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const harness = RecursiveHarness.create(config);
    const result = await harness.chat({
      userId: "user_1",
      sessionId: "session_1",
      input: "hello"
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.toolCalls).toHaveLength(0);
    expect(result.output).toBe("What would you like to know?");
    expect(result.output.toLowerCase()).not.toContain("harness");
    expect(result.output.toLowerCase()).not.toContain("vps");
    expect(result.output.toLowerCase()).not.toContain("runtime");

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    }
  });

  it("fails loudly instead of pretending to answer when Ollama is not configured", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    const harness = RecursiveHarness.create(config);

    await expect(harness.chat({
      userId: "user_1",
      sessionId: "session_1",
      input: "what?"
    })).rejects.toThrow("Ollama is not configured");

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    }
  });

  it("sends private capability instructions to Ollama for real model behavior", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: { content: "I can help update that setting." } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const harness = RecursiveHarness.create({
      ...config,
      memory: { kind: "file", directory: join(tmpdir(), `recursive-harness-capabilities-${Date.now()}`) },
      updates: { webhookUrl: "https://example.com/updates", apiKey: "secret", channel: "production" }
    });

    await harness.chat({
      userId: "user_1",
      sessionId: "session_1",
      input: "Can you change how the app behaves?"
    });

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: Array<{ role: string; content: string }> };
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain("host app update delivery");
    expect(system).toContain("Do not mention or expose hidden infrastructure");

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("keeps conversational memory by default without requiring file memory config", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: "I'll remember that your name is Sam." } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: "Your name is Sam." } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const harness = RecursiveHarness.create(config);

    await harness.chat({
      userId: "user_1",
      sessionId: "chat_memory",
      input: "My name is Sam."
    });
    await harness.chat({
      userId: "user_1",
      sessionId: "chat_memory",
      input: "What is my name?"
    });

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: Array<{ role: string; content: string }> };
    const secondUserPayload = JSON.parse(secondBody.messages.find((message) => message.role === "user")?.content ?? "{}") as {
      memory: Array<{ role: string; content: string }>;
    };
    expect(secondUserPayload.memory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "My name is Sam." }),
        expect.objectContaining({ role: "assistant", content: "I'll remember that your name is Sam." })
      ])
    );

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("supports callback-based streaming through chatStream", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content: "stream" } })}\n`));
            controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content: " works" }, done: true })}\n`));
            controller.close();
          }
        }),
        { status: 200 }
      )
    );
    const harness = RecursiveHarness.create(config);
    const seen: string[] = [];

    const result = await harness.chatStream({
      userId: "user_1",
      sessionId: "stream_chat",
      input: "stream this"
    }, (event) => {
      if (event.type === "token") {
        seen.push(String(event.data));
      }
    });

    expect(seen.join("")).toBe("stream works");
    expect(result.output).toBe("stream works");

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("does not route current-data requests through TinyFish unless search is enabled", async () => {
    const tinyfishKey = process.env.TINYFISH_API_KEY;
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.TINYFISH_API_KEY = "test-tinyfish-key";
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: { content: "I cannot verify that without search enabled." } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const harness = RecursiveHarness.create(config);
    const result = await harness.run({
      userId: "user_1",
      sessionId: "session_1",
      input: "What is the latest Ollama Cloud Gemma 4 API status today?"
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.toolCalls).toHaveLength(0);

    if (tinyfishKey) {
      process.env.TINYFISH_API_KEY = tinyfishKey;
    } else {
      delete process.env.TINYFISH_API_KEY;
    }
    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    }
  });

  it("routes current-data requests through TinyFish when search is enabled", async () => {
    const tinyfishKey = process.env.TINYFISH_API_KEY;
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.TINYFISH_API_KEY = "test-tinyfish-key";
    process.env.OLLAMA_API_KEY = "test-ollama-key";

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
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
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: "Gemma 4 is available according to the supplied result." } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    const harness = RecursiveHarness.create({
      ...config,
      search: { enabled: true, provider: "tinyfish", mode: "freshness" }
    });
    const result = await harness.run({
      userId: "user_1",
      sessionId: "session_1",
      input: "What is the latest Ollama Cloud Gemma 4 API status today?"
    });

    expect(needsFreshSearch("latest pricing today")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("searches when the user corrects an outdated answer", async () => {
    const tinyfishKey = process.env.TINYFISH_API_KEY;
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.TINYFISH_API_KEY = "test-tinyfish-key";
    process.env.OLLAMA_API_KEY = "test-ollama-key";

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Anthropic model release",
                url: "https://example.com/anthropic",
                snippet: "Anthropic announced a newer model."
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: "You're right, that earlier answer was outdated. Anthropic has a newer release." } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    const harness = RecursiveHarness.create({
      ...config,
      search: { enabled: true, provider: "tinyfish", mode: "freshness" }
    });
    const result = await harness.run({
      userId: "user_1",
      sessionId: "anthropic_latest",
      input: "no that is outdated, search for the latest Anthropic model"
    });

    expect(result.toolCalls[0]?.name).toBe("tinyfishSearch");
    expect(result.toolCalls[0]?.ok).toBe(true);

    if (tinyfishKey) {
      process.env.TINYFISH_API_KEY = tinyfishKey;
    } else {
      delete process.env.TINYFISH_API_KEY;
    }
    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    }
  });

  it("streams conversational responses and writes file-backed memory", async () => {
    const memoryDir = join(tmpdir(), `recursive-harness-memory-${Date.now()}`);
    await mkdir(memoryDir, { recursive: true });
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content: "Hello" } })}\n`));
            controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content: " there" }, done: true })}\n`));
            controller.close();
          }
        }),
        { status: 200 }
      )
    );

    const harness = RecursiveHarness.create({
      ...config,
      memory: { kind: "file", directory: memoryDir, maxMessagesPerSession: 10 }
    });

    const events = [];
    for await (const event of harness.runStream({
      userId: "user_1",
      sessionId: "chat_1",
      input: "remember that I like concise answers"
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain("token");
    expect(events.at(-1)?.type).toBe("done");
    expect(JSON.stringify(events)).not.toContain("runtimeImageId");

    const exported = await harness.exportTrainingData();
    expect(exported?.count).toBe(1);
    expect(exported?.content).toContain("remember that I like concise answers");

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
    await rm(memoryDir, { recursive: true, force: true });
  });

  it("delivers configured app updates through a webhook", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const harness = RecursiveHarness.create({
      ...config,
      updates: {
        webhookUrl: "https://example.com/harness-updates",
        apiKey: "update-secret",
        channel: "beta"
      }
    });

    const update = await harness.sendUpdate({
      title: "Enable compact chat",
      description: "Host app can switch to compact chat controls without reinstall.",
      kind: "ui_config",
      payload: { compactChat: true }
    });

    expect(update?.channel).toBe("beta");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/harness-updates",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer update-secret" })
      })
    );
  });

  it("runs researcher and upgrader agents and queues a VPS upgrade task", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            title: "Improve memory continuity",
            problem: "Users ask follow-up questions and expect prior turns to be available.",
            evidence: ["follow-up question after first turn"],
            recommendedChange: "Expose stronger session memory defaults and tests.",
            expectedImpact: "Better multi-turn chat.",
            risk: "low",
            updateKind: "runtime_policy",
            payload: { memory: "session-default" }
          })
        }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            summary: "Apply session memory policy update",
            updateTitle: "Session memory policy",
            updateDescription: "Use prior session turns when answering follow-ups.",
            updateKind: "runtime_policy",
            payload: { memoryPolicy: "session-continuity" },
            reasons: ["Researcher found follow-up failures"]
          })
        }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const harness = RecursiveHarness.create({
      ...config,
      updates: { webhookUrl: "https://example.com/updates", apiKey: "secret", channel: "production" },
      agents: { workerId: "sparky-vps", autoQueueUpgrades: true }
    });
    harness.trackExperience({
      userId: "user_1",
      sessionId: "session_1",
      message: "it forgot what I said",
      response: "sorry",
      outcome: "failed"
    });

    const result = await harness.runRecursiveImprovementCycle();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result?.proposal.title).toBe("Improve memory continuity");
    expect(result?.plan.status).toBe("queued");
    expect(result?.plan.taskId).toBeTruthy();

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
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
