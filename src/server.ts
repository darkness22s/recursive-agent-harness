import { Hono } from "hono";
import { RecursiveRuntime } from "./runtime.js";
import type { HarnessConfig } from "./types.js";
import { renderDashboard } from "./dashboard.js";

export function createRuntimeServer(runtime = new RecursiveRuntime()): Hono {
  const app = new Hono();

  app.use("/v1/*", async (context, next) => {
    const expected = process.env.RECURSIVE_HARNESS_API_KEY;
    if (expected && context.req.header("authorization") !== `Bearer ${expected}`) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/", (context) => {
    const range = context.req.query("range") === "7d" ? "7d" : "24h";
    return context.html(renderDashboard(runtime.store.statusReport(range)));
  });

  app.get("/health", (context) => context.json({ ok: true, activeRuntimeImageId: runtime.store.activeImage().id }));

  app.post("/v1/tools", async (context) => {
    const body = (await context.req.json()) as { manifest: { name: string; description: string; schema: unknown } };
    runtime.registerToolManifest(body.manifest);
    return context.json({ ok: true });
  });

  app.post("/v1/run", async (context) => {
    const body = (await context.req.json()) as { config: HarnessConfig; input: Parameters<RecursiveRuntime["run"]>[1] };
    const result = await runtime.run(body.config, body.input);
    return context.json(result);
  });

  app.post("/v1/events", async (context) => {
    const body = (await context.req.json()) as { config: HarnessConfig; event: Parameters<RecursiveRuntime["trackExperience"]>[1] };
    return context.json(runtime.trackExperience(body.config, body.event));
  });

  app.post("/v1/snapshots", async (context) => {
    const body = (await context.req.json()) as { snapshot: Parameters<RecursiveRuntime["snapshot"]>[0] };
    return context.json(runtime.snapshot(body.snapshot));
  });

  app.post("/v1/recursion/tick", (context) => context.json(runtime.tick()));

  app.post("/v1/agent/summary", (context) => context.json(runtime.createFiveHourSummary()));

  app.post("/v1/recursion/rollback-check", async (context) => {
    const body = (await context.req.json()) as { recentScore: number };
    return context.json(runtime.rollbackIfNeeded(body.recentScore) ?? null);
  });

  app.get("/v1/successor/active", (context) => context.json(runtime.store.activeImage()));

  app.get("/v1/successor/history", (context) => context.json(runtime.store.promotions));

  app.get("/v1/status", (context) => {
    const range = context.req.query("range") === "7d" ? "7d" : "24h";
    return context.json(runtime.store.statusReport(range));
  });

  app.post("/v1/local-workers/heartbeat", async (context) => {
    const body = (await context.req.json()) as { id: string; name: string; capabilities?: string[] };
    return context.json(runtime.store.upsertLocalWorker({
      id: body.id,
      name: body.name,
      capabilities: body.capabilities ?? ["shell"]
    }));
  });

  app.post("/v1/local-workers/:id/tasks", async (context) => {
    const body = (await context.req.json()) as { command: string; shell?: "powershell" | "cmd" | "node" | "bash" };
    return context.json(runtime.store.enqueueLocalTask({
      workerId: context.req.param("id"),
      command: body.command,
      shell: body.shell ?? "powershell"
    }));
  });

  app.get("/v1/local-workers/:id/tasks/next", (context) => {
    return context.json(runtime.store.nextLocalTask(context.req.param("id")) ?? null);
  });

  app.post("/v1/local-workers/:id/tasks/:taskId/result", async (context) => {
    const body = (await context.req.json()) as { status: "succeeded" | "failed"; output?: string; error?: string };
    return context.json(runtime.store.completeLocalTask(context.req.param("taskId"), body));
  });

  return app;
}
