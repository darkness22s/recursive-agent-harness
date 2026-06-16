import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  RecursiveHarness.resetLocalRuntimes();
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
        new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "answer" }) } }), {
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

  it("continues the agent loop after a search observation to call a matching host tool", async () => {
    const tinyfishKey = process.env.TINYFISH_API_KEY;
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.TINYFISH_API_KEY = "test-tinyfish-key";
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ title: "Current release", url: "https://example.com/release", snippet: "Fresh data" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "saveResearch", input: { title: "Current release" } }) } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "answer" }) } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: "Saved the latest release note." } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const harness = RecursiveHarness.create({
      ...config,
      search: { enabled: true, provider: "tinyfish", mode: "freshness" },
      agentLoop: { maxSteps: 4, maxToolCalls: 3 }
    });

    harness.registerTool({
      name: "saveResearch",
      description: "Stores a public research note",
      inputSchema: z.object({ title: z.string() }),
      execute: (input) => ({ saved: true, title: input.title })
    });

    const result = await harness.run({
      userId: "user_1",
      sessionId: "loop_multi_step",
      input: "Search for the latest release and save it"
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.toolCalls.map((call) => call.name)).toEqual(["tinyfishSearch", "saveResearch"]);
    expect(result.toolCalls.every((call) => call.ok)).toBe(true);
    expect(result.output).toBe("Saved the latest release note.");

    if (tinyfishKey) {
      process.env.TINYFISH_API_KEY = tinyfishKey;
    } else {
      delete process.env.TINYFISH_API_KEY;
    }
    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("stops repeated tool actions before they loop", async () => {
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
        new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "createProject", input: { name: "Apollo" } }) } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: "I stopped after creating the project once." } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const harness = RecursiveHarness.create({
      ...config,
      agentLoop: { maxSteps: 4, maxToolCalls: 3 }
    });

    harness.registerTool({
      name: "createProject",
      description: "Creates a project",
      inputSchema: z.object({ name: z.string() }),
      execute: (input) => ({ id: "project_1", name: input.name })
    });

    const result = await harness.run({
      userId: "user_1",
      sessionId: "repeat_guard",
      input: "createProject Apollo"
    });

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toMatchObject({ name: "createProject", ok: true });
    expect(result.toolCalls[1]).toMatchObject({ name: "agentLoop", ok: false, error: "Agent loop stopped a repeated action." });

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("blocks high-risk tools until the host provides approval handling", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "deleteAccount", input: { id: "user_1" } }) } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: "I cannot complete that without approval." } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const harness = RecursiveHarness.create(config);

    harness.registerTool({
      name: "deleteAccount",
      description: "Deletes an account",
      risk: "high",
      inputSchema: z.object({ id: z.string() }),
      execute: () => ({ deleted: true })
    });

    const result = await harness.run({
      userId: "user_1",
      sessionId: "approval_guard",
      input: "delete my account"
    });

    expect(result.toolCalls[0]).toMatchObject({
      name: "deleteAccount",
      ok: false,
      error: "Tool requires host approval before execution."
    });
    expect(result.toolCalls[0]?.approvalId).toEqual(expect.any(String));

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("resumes a high-risk tool after explicit host approval", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "deleteAccount", input: { id: "user_1" } }) } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: "Approval is required." } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const harness = RecursiveHarness.create({
      ...config,
      appId: `approval-flow-${Date.now()}`
    });
    const executed: string[] = [];

    harness.registerTool({
      name: "deleteAccount",
      description: "Deletes an account",
      risk: "high",
      requiresApproval: true,
      inputSchema: z.object({ id: z.string() }),
      execute: (input, context) => {
        executed.push(`${context.userId}:${input.id}`);
        return { deleted: true, id: input.id };
      }
    });

    const result = await harness.run({
      userId: "user_1",
      sessionId: "approval_resume",
      input: "delete my account"
    });
    const approvalId = result.toolCalls[0]?.approvalId;

    expect(approvalId).toEqual(expect.any(String));
    expect(executed).toEqual([]);
    expect(await harness.listPendingApprovals()).toEqual([
      expect.objectContaining({
        id: approvalId,
        toolName: "deleteAccount",
        status: "pending",
        input: { id: "user_1" }
      })
    ]);

    const approved = await harness.approveToolCall(String(approvalId), { approved: true, reason: "User confirmed destructive action." });

    expect(approved).toMatchObject({
      name: "deleteAccount",
      ok: true,
      input: { id: "user_1" },
      output: { deleted: true, id: "user_1" }
    });
    expect(executed).toEqual(["user_1:user_1"]);
    expect(await harness.listPendingApprovals()).toEqual([]);

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("ships opt-in built-in list, read, write, edit, search, command, feedback, and task tools", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const workspace = join(tmpdir(), `recursive-harness-tools-${Date.now()}`);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "notes.txt"), "alpha\nbeta\n", "utf8");

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "listFiles", input: { path: "." } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "readFile", input: { path: "notes.txt", startLine: 2, endLine: 2 } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "writeFile", input: { path: "out/result.txt", content: "done" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "editFile", input: { path: "out/result.txt", oldText: "done", newText: "done edited" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "searchFiles", input: { query: "beta" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "runCommand", input: { command: "node -e \"console.log('ok')\"" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "noteDislikedResult", input: { reason: "Too vague", avoid: "generic apologies", preferred: "specific action" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "upsertTask", input: { id: "task_1", title: "Finish local tool pass", status: "in_progress", detail: "Use built-in tools and verify state." } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "listTasks", input: { status: "in_progress" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "completeTask", input: { id: "task_1", result: "Verified task state." } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "answer" }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "I used the local tools." } }), { status: 200, headers: { "content-type": "application/json" } }));

    const harness = RecursiveHarness.create({
      ...config,
      appId: `built-in-tools-${Date.now()}`,
      builtInTools: {
        enabled: true,
        workspaceRoot: workspace,
        list: true,
        read: true,
        write: true,
        edit: true,
        search: true,
        command: true,
        feedback: true,
        tasks: true,
        allowedCommands: ["node"]
      },
      agentLoop: { maxSteps: 13, maxToolCalls: 11 }
    });

    const result = await harness.run({
      userId: "user_1",
      sessionId: "built_in_tools",
      input: "Read the note, write a result, search beta, run node, track the task, and remember that I disliked vague answers."
    });

    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(result.toolCalls.map((call) => call.name)).toEqual(["listFiles", "readFile", "writeFile", "editFile", "searchFiles", "runCommand", "noteDislikedResult", "upsertTask", "listTasks", "completeTask"]);
    expect(result.toolCalls.every((call) => call.ok)).toBe(true);
    expect(result.toolCalls[0]?.output).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ name: "notes.txt", type: "file" })]) });
    expect(result.toolCalls[1]?.output).toMatchObject({ content: "beta" });
    expect(result.toolCalls[3]?.output).toMatchObject({ replacements: 1 });
    expect(result.toolCalls[5]?.output).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("ok") });
    expect(result.toolCalls[8]?.output).toMatchObject({ tasks: [expect.objectContaining({ id: "task_1", status: "in_progress" })] });
    expect(result.toolCalls[9]?.output).toMatchObject({ task: expect.objectContaining({ id: "task_1", status: "done", result: "Verified task state." }) });
    expect(await readFile(join(workspace, "out/result.txt"), "utf8")).toBe("done edited");
    expect(await readFile(join(workspace, ".recursive-harness/disliked-results.jsonl"), "utf8")).toContain("Too vague");
    expect(await readFile(join(workspace, ".recursive-harness/tasks.json"), "utf8")).toContain("\"status\": \"done\"");

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
    await rm(workspace, { recursive: true, force: true });
  });

  it("rejects ambiguous editFile replacements unless replaceAll is set", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const workspace = join(tmpdir(), `recursive-harness-edit-ambiguous-${Date.now()}`);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "repeat.txt"), "same\nsame\n", "utf8");

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "editFile", input: { path: "repeat.txt", oldText: "same", newText: "changed" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "The edit was ambiguous." } }), { status: 200, headers: { "content-type": "application/json" } }));

    const harness = RecursiveHarness.create({
      ...config,
      appId: `edit-ambiguous-${Date.now()}`,
      builtInTools: {
        enabled: true,
        workspaceRoot: workspace,
        edit: true
      }
    });

    const result = await harness.run({
      userId: "user_1",
      sessionId: "edit_ambiguous",
      input: "Replace same with changed"
    });

    expect(result.toolCalls[0]).toMatchObject({
      name: "editFile",
      ok: false,
      error: "oldText matched 2 times. Set replaceAll=true or provide a more specific oldText."
    });
    expect(await readFile(join(workspace, "repeat.txt"), "utf8")).toBe("same\nsame\n");

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns stdout and stderr for failed built-in commands", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const workspace = join(tmpdir(), `recursive-harness-failed-command-${Date.now()}`);
    await mkdir(workspace, { recursive: true });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "runCommand", input: { command: "node -e \"console.error('bad'); process.exit(3)\"" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "answer" }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "The command failed with diagnostics." } }), { status: 200, headers: { "content-type": "application/json" } }));

    const harness = RecursiveHarness.create({
      ...config,
      appId: `failed-command-${Date.now()}`,
      builtInTools: {
        enabled: true,
        workspaceRoot: workspace,
        command: true,
        allowedCommands: ["node"]
      }
    });

    const result = await harness.run({
      userId: "user_1",
      sessionId: "failed_command",
      input: "Run the failing node command."
    });

    expect(result.toolCalls[0]?.ok).toBe(true);
    expect(result.toolCalls[0]?.output).toMatchObject({
      exitCode: 3,
      stderr: expect.stringContaining("bad")
    });

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
    await rm(workspace, { recursive: true, force: true });
  });

  it("loads disliked-result notes into later conversation memory", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const workspace = join(tmpdir(), `recursive-harness-feedback-${Date.now()}`);
    await mkdir(workspace, { recursive: true });

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "noteDislikedResult", input: { reason: "Too vague", avoid: "generic apologies", preferred: "specific next action" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "answer" }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "Noted." } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "answer" }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "Here is a specific next action." } }), { status: 200, headers: { "content-type": "application/json" } }));

    const harness = RecursiveHarness.create({
      ...config,
      appId: `feedback-memory-${Date.now()}`,
      builtInTools: {
        enabled: true,
        workspaceRoot: workspace,
        feedback: true
      }
    });

    await harness.run({
      userId: "user_1",
      sessionId: "feedback_session",
      input: "I disliked that result because it was too vague."
    });
    await harness.run({
      userId: "user_1",
      sessionId: "feedback_session",
      input: "Try again."
    });

    const secondPlannerBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as { messages: Array<{ role: string; content: string }> };
    const plannerPayload = JSON.parse(secondPlannerBody.messages.find((message) => message.role === "user")?.content ?? "{}") as {
      memory: Array<{ role: string; content: string }>;
    };
    expect(JSON.stringify(plannerPayload.memory)).toContain("User feedback from disliked prior results");
    expect(JSON.stringify(plannerPayload.memory)).toContain("avoid=generic apologies");
    expect(JSON.stringify(plannerPayload.memory)).toContain("preferred=specific next action");

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
    await rm(workspace, { recursive: true, force: true });
  });

  it("prepares built-in tools inside the runtime for hosted/server execution", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const workspace = join(tmpdir(), `recursive-harness-server-tools-${Date.now()}`);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "server-note.txt"), "server path works", "utf8");

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "readFile", input: { path: "server-note.txt" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "answer" }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "Read it." } }), { status: 200, headers: { "content-type": "application/json" } }));

    const runtime = new RecursiveRuntime();
    const result = await runtime.run({
      ...config,
      builtInTools: {
        enabled: true,
        workspaceRoot: workspace,
        read: true
      }
    }, {
      userId: "user_1",
      sessionId: "server_tools",
      input: "Read server-note.txt"
    });

    expect(result.toolCalls[0]?.name).toBe("readFile");
    expect(result.toolCalls[0]?.output).toMatchObject({ content: "server path works" });

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
    await rm(workspace, { recursive: true, force: true });
  });

  it("executes manifest-only hosted tools through toolExecutor webhook", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "createTicket", input: { title: "Bug" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, output: { id: "ticket_1", title: "Bug" } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "answer" }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "Created ticket_1." } }), { status: 200, headers: { "content-type": "application/json" } }));

    const runtime = new RecursiveRuntime();
    runtime.registerToolManifest({
      name: "createTicket",
      description: "Create a support ticket",
      schema: {
        kind: "json-schema",
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"]
        }
      },
      risk: "medium"
    });

    const result = await runtime.run({
      ...config,
      toolExecutor: {
        webhookUrl: "https://example.com/tools",
        apiKey: "tool-secret"
      }
    }, {
      userId: "user_1",
      sessionId: "remote_tool",
      input: "Create a ticket"
    });

    expect(result.toolCalls[0]).toMatchObject({
      name: "createTicket",
      ok: true,
      output: { id: "ticket_1", title: "Bug" }
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://example.com/tools");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer tool-secret" })
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      toolName: "createTicket",
      input: { title: "Bug" },
      context: { userId: "user_1", sessionId: "remote_tool", appId: "test-app" }
    });

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("fails clearly for manifest-only tools without a tool executor", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "createTicket", input: { title: "Bug" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "I cannot execute that tool yet." } }), { status: 200, headers: { "content-type": "application/json" } }));

    const runtime = new RecursiveRuntime();
    runtime.registerToolManifest({
      name: "createTicket",
      description: "Create a support ticket",
      schema: { kind: "json-schema", schema: { type: "object" } }
    });

    const result = await runtime.run(config, {
      userId: "user_1",
      sessionId: "remote_tool_missing",
      input: "Create a ticket"
    });

    expect(result.toolCalls[0]).toMatchObject({
      name: "createTicket",
      ok: false,
      error: "Tool is registered as a manifest only. Configure toolExecutor.webhookUrl to execute hosted custom tools."
    });

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("sends concrete built-in tool input schemas to the planner", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const workspace = join(tmpdir(), `recursive-harness-schema-${Date.now()}`);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "schema-note.txt"), "shape", "utf8");

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "readFile", input: { path: "schema-note.txt" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "answer" }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "Read it." } }), { status: 200, headers: { "content-type": "application/json" } }));

    const runtime = new RecursiveRuntime();
    await runtime.run({
      ...config,
      builtInTools: {
        enabled: true,
        workspaceRoot: workspace,
        read: true
      }
    }, {
      userId: "user_1",
      sessionId: "schema_tools",
      input: "Read schema-note.txt"
    });

    const plannerBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: Array<{ role: string; content: string }> };
    const plannerPayload = JSON.parse(plannerBody.messages.find((message) => message.role === "user")?.content ?? "{}") as {
      availableTools: Array<{ name: string; schema: { kind?: string; schema?: { properties?: Record<string, unknown>; required?: string[] } } }>;
    };
    const readFileTool = plannerPayload.availableTools.find((tool) => tool.name === "readFile");
    expect(readFileTool?.schema.kind).toBe("json-schema");
    expect(readFileTool?.schema.schema?.properties).toHaveProperty("path");
    expect(readFileTool?.schema.schema?.properties).toHaveProperty("startLine");
    expect(readFileTool?.schema.schema?.required).toContain("path");

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
    await rm(workspace, { recursive: true, force: true });
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

  it("keeps memory when the host recreates the local SDK between chat turns", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const uniqueConfig = {
      ...config,
      appId: `memory-recreate-${Date.now()}`
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: "I'll remember that you prefer short answers." } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: "You prefer short answers." } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    await RecursiveHarness.create(uniqueConfig).chat({
      userId: "user_1",
      sessionId: "recreated_sdk_memory",
      input: "Remember that I prefer short answers."
    });
    await RecursiveHarness.create(uniqueConfig).chat({
      userId: "user_1",
      sessionId: "recreated_sdk_memory",
      input: "What do I prefer?"
    });

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: Array<{ role: string; content: string }> };
    const secondUserPayload = JSON.parse(secondBody.messages.find((message) => message.role === "user")?.content ?? "{}") as {
      memory: Array<{ role: string; content: string }>;
    };
    expect(secondUserPayload.memory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Remember that I prefer short answers." }),
        expect.objectContaining({ role: "assistant", content: "I'll remember that you prefer short answers." })
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

  it("does not force web search for urgent command text", async () => {
    const tinyfishKey = process.env.TINYFISH_API_KEY;
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.TINYFISH_API_KEY = "test-tinyfish-key";
    process.env.OLLAMA_API_KEY = "test-ollama-key";

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "answer" }) } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: "I can start on that." } }), {
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
      sessionId: "no_search_now",
      input: "start doing it NOW"
    });

    expect(needsFreshSearch("start doing it NOW")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toHaveLength(0);

    if (tinyfishKey) {
      process.env.TINYFISH_API_KEY = tinyfishKey;
    } else {
      delete process.env.TINYFISH_API_KEY;
    }
    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
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
        new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "answer" }) } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
        new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "answer" }) } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
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

  it("cancels a local stream with an AbortSignal before model work starts", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort();
    const harness = RecursiveHarness.create(config);

    const events = [];
    for await (const event of harness.runStream({
      userId: "user_1",
      sessionId: "cancel_stream",
      input: "this should stop"
    }, { signal: controller.signal })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events.at(-1)?.data).toBe("Stream aborted.");
    expect(fetchMock).not.toHaveBeenCalled();

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("emits approval_required while streaming risky tool calls", async () => {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ action: "tool", toolName: "deleteAccount", input: { id: "user_1" } }) } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "Approval is required." } }), { status: 200, headers: { "content-type": "application/json" } }));

    const harness = RecursiveHarness.create({
      ...config,
      appId: `approval-stream-${Date.now()}`
    });

    harness.registerTool({
      name: "deleteAccount",
      description: "Deletes an account",
      risk: "high",
      requiresApproval: true,
      inputSchema: z.object({ id: z.string() }),
      execute: () => ({ deleted: true })
    });

    const events = [];
    for await (const event of harness.runStream({
      userId: "user_1",
      sessionId: "approval_stream",
      input: "delete my account"
    })) {
      events.push(event);
    }

    const approvalEvent = events.find((event) => event.type === "approval_required");
    expect(events.map((event) => event.type)).toContain("tool_call");
    expect(approvalEvent?.data).toMatchObject({
      name: "deleteAccount",
      ok: false,
      approvalId: expect.any(String),
      error: "Tool requires host approval before execution."
    });

    if (ollamaKey) {
      process.env.OLLAMA_API_KEY = ollamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
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
