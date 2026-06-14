import { describe, expect, it } from "vitest";
import { createRuntimeServer } from "../src/index.js";

describe("runtime HTTP server", () => {
  it("accepts events and exposes active successor state", async () => {
    const app = createRuntimeServer();

    const eventResponse = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          appId: "http-test",
          runtimeUrl: "local",
          apiKey: "dev",
          optimization: "retention",
          autonomy: "full"
        },
        event: {
          userId: "user_1",
          sessionId: "session_1",
          message: "this is broken and I am mad",
          response: "repairing",
          outcome: "continued"
        }
      })
    });

    const event = (await eventResponse.json()) as { sentimentSignals: { anger: boolean } };
    const activeResponse = await app.request("/v1/successor/active");
    const active = (await activeResponse.json()) as { status: string };

    expect(event.sentimentSignals.anger).toBe(true);
    expect(active.status).toBe("active");
  });

  it("renders a dashboard, status ranges, summaries, and local worker tasks", async () => {
    const app = createRuntimeServer();

    const heartbeat = await app.request("/v1/local-workers/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "pc-1", name: "Lenovo PC", capabilities: ["powershell"] })
    });
    expect(heartbeat.status).toBe(200);

    const taskResponse = await app.request("/v1/local-workers/pc-1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "Write-Output hello", shell: "powershell" })
    });
    const task = (await taskResponse.json()) as { id: string; status: string };
    expect(task.status).toBe("queued");

    const nextResponse = await app.request("/v1/local-workers/pc-1/tasks/next");
    const next = (await nextResponse.json()) as { id: string; status: string };
    expect(next.id).toBe(task.id);
    expect(next.status).toBe("running");

    await app.request(`/v1/local-workers/pc-1/tasks/${task.id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "succeeded", output: "hello" })
    });

    const summaryResponse = await app.request("/v1/agent/summary", { method: "POST" });
    const summary = (await summaryResponse.json()) as { message: string };
    expect(summary.message).toContain("will not stop");

    const statusResponse = await app.request("/v1/status?range=7d");
    const status = (await statusResponse.json()) as { stats: { range: string; localTasksCompleted: number; summaries: number } };
    expect(status.stats.range).toBe("7d");
    expect(status.stats.localTasksCompleted).toBe(1);
    expect(status.stats.summaries).toBe(1);

    const dashboardResponse = await app.request("/?range=24h");
    expect(await dashboardResponse.text()).toContain("Recursive Harness Status");
  });
});
