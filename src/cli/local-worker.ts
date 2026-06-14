import { exec } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import type { LocalTask, LocalWorkerRecord } from "../types.js";

const execAsync = promisify(exec);
const runtimeUrl = process.env.RECURSIVE_RUNTIME_URL ?? "http://localhost:4317";
const runtimeKey = process.env.RECURSIVE_HARNESS_API_KEY;
const workerId = process.env.RECURSIVE_LOCAL_WORKER_ID ?? `${hostname()}-worker`;
const workerName = process.env.RECURSIVE_LOCAL_WORKER_NAME ?? `${hostname()} local worker`;
const intervalMs = Number(process.env.RECURSIVE_LOCAL_WORKER_INTERVAL_MS ?? 30000);
const runOnce = process.env.RECURSIVE_LOCAL_WORKER_ONCE === "1";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${runtimeUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(runtimeKey ? { authorization: `Bearer ${runtimeKey}` } : {}),
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function heartbeat(): Promise<LocalWorkerRecord> {
  return request("/v1/local-workers/heartbeat", {
    method: "POST",
    body: JSON.stringify({
      id: workerId,
      name: workerName,
      capabilities: process.platform === "win32" ? ["powershell", "cmd", "node"] : ["bash", "node"]
    })
  });
}

async function nextTask(): Promise<LocalTask | null> {
  return request(`/v1/local-workers/${encodeURIComponent(workerId)}/tasks/next`);
}

async function report(task: LocalTask, result: { status: "succeeded" | "failed"; output?: string; error?: string }): Promise<void> {
  await request(`/v1/local-workers/${encodeURIComponent(workerId)}/tasks/${encodeURIComponent(task.id)}/result`, {
    method: "POST",
    body: JSON.stringify(result)
  });
}

async function runTask(task: LocalTask): Promise<void> {
  try {
    const command = task.shell === "node"
      ? `node -e "${task.command.replace(/"/g, '\\"')}"`
      : task.shell === "cmd"
        ? `cmd /c ${task.command}`
        : task.shell === "bash"
          ? `bash -lc ${JSON.stringify(task.command)}`
          : `powershell -NoProfile -ExecutionPolicy Bypass -Command ${JSON.stringify(task.command)}`;
    const { stdout, stderr } = await execAsync(command, {
      timeout: Number(process.env.RECURSIVE_LOCAL_TASK_TIMEOUT_MS ?? 120000),
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    await report(task, {
      status: "succeeded",
      output: [stdout, stderr].filter(Boolean).join("\n").trim()
    });
  } catch (error) {
    await report(task, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function loop(): Promise<void> {
  await heartbeat();
  const task = await nextTask();
  if (task) {
    await runTask(task);
  }
}

console.log(`Local worker ${workerId} polling ${runtimeUrl} every ${intervalMs}ms`);
await loop();
if (!runOnce) {
  setInterval(() => {
    void loop().catch((error) => console.error("local worker loop failed", error));
  }, intervalMs);
} else {
  console.log(`Local worker ${workerId} completed one polling cycle.`);
}
