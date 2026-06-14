import { createRuntimeServer } from "../src/index.js";

const app = createRuntimeServer();

const heartbeat = await app.request("/v1/local-workers/heartbeat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "smoke-worker", name: "Smoke Local Worker", capabilities: ["powershell"] })
});

const taskResponse = await app.request("/v1/local-workers/smoke-worker/tasks", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ shell: "powershell", command: "Write-Output smoke-ok" })
});
const task = await taskResponse.json() as { id: string };

const nextResponse = await app.request("/v1/local-workers/smoke-worker/tasks/next");
const next = await nextResponse.json() as { id: string };

await app.request(`/v1/local-workers/smoke-worker/tasks/${next.id}/result`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: "succeeded", output: "smoke-ok" })
});

await app.request("/v1/agent/summary", { method: "POST" });
const status = await app.request("/v1/status?range=24h");
const dashboard = await app.request("/?range=24h");

console.log(JSON.stringify({
  heartbeat: heartbeat.status,
  task,
  next,
  status: await status.json(),
  dashboardContainsStatus: (await dashboard.text()).includes("Recursive Harness Status")
}, null, 2));
