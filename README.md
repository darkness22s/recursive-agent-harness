# Recursive Agent Harness

A framework-style TypeScript/Node SDK plus an autonomous successor runtime engine.

The SDK wires into a host app without source-code access. The runtime observes host-provided events, tool schemas, and user experience signals, then builds, evaluates, promotes, and rolls back full successor runtime images.

## Install

Install directly from GitHub:

```bash
npm install github:darkness22s/recursive-agent-harness
```

Or, after the GitHub Packages workflow publishes a release:

```bash
npm config set @darkness22s:registry https://npm.pkg.github.com
npm install @darkness22s/recursive-harness-engine
```

For local development in this repository:

```bash
npm install
npm run build
npm test
```

## SDK Quick Start

## Gemma 4 on Ollama Cloud

Create an Ollama Cloud API key, then set:

```bash
set OLLAMA_HOST=https://ollama.com
set OLLAMA_API_KEY=your_ollama_cloud_api_key
set RECURSIVE_HARNESS_MODEL=gemma4:31b
```

For PowerShell:

```powershell
$env:OLLAMA_HOST="https://ollama.com"
$env:OLLAMA_API_KEY="your_ollama_cloud_api_key"
$env:RECURSIVE_HARNESS_MODEL="gemma4:31b"
```

When `OLLAMA_API_KEY` is present, the runtime calls Ollama Cloud for user-facing harness responses. Without the key, it falls back to deterministic local responses so tests and development still run.

## TinyFish Search Tool

Search is **off by default** for consumer chat. Set `TINYFISH_API_KEY` and opt in with `search.enabled` only when your product wants current-data lookup:

```powershell
$env:TINYFISH_API_KEY="your_tinyfish_api_key"
```

When enabled and triggered by a current-data request, search appears in `result.toolCalls` as `tinyfishSearch`. A normal message like `"hello"` does not call TinyFish.

```ts
import { RecursiveHarness } from "@darkness22s/recursive-harness-engine";
import { z } from "zod";

const harness = RecursiveHarness.create({
  appId: "my-product",
  runtimeUrl: "local",
  apiKey: "dev",
  optimization: "retention",
  autonomy: "full",
  search: {
    enabled: true,
    provider: "tinyfish",
    mode: "freshness"
  }
});

harness.registerTool({
  name: "createProject",
  description: "Creates a project for the user",
  inputSchema: z.object({ name: z.string() }),
  execute: async (input, ctx) => ({ id: "project_1", owner: ctx.userId, ...input })
});

const answer = await harness.run({
  userId: "user_1",
  sessionId: "session_1",
  input: "What is the latest Ollama Cloud Gemma 4 status today?",
  context: { plan: "pro" }
});

console.log(answer.toolCalls);
// [{ name: "tinyfishSearch", ok: true, input: { query: "..." }, output: { results: [...] } }]

harness.trackExperience({
  userId: "user_1",
  sessionId: "session_1",
  message: "that worked, thanks",
  response: answer.output,
  outcome: "continued"
});
```

## Conversational Streaming And Memory

The SDK is designed for normal user chat. End-user responses should not mention the harness, VPS workers, runtime images, internal tools, API keys, telemetry, or deployment details. Those are operator concerns for your product/backend.

Configure file-backed memory when creating the harness:

```ts
const harness = RecursiveHarness.create({
  appId: "my-product",
  runtimeUrl: "local",
  apiKey: "dev",
  optimization: "retention",
  autonomy: "full",
  memory: {
    kind: "file",
    directory: "./harness-memory",
    maxMessagesPerSession: 40
  }
});
```

Use `chat()` for normal conversational turns:

```ts
const result = await harness.chat({
  userId: "user_1",
  sessionId: "session_1",
  input: "Remember that I like concise answers."
});
```

Use `runStream()` when your UI wants token-by-token output:

```ts
for await (const event of harness.runStream({
  userId: "user_1",
  sessionId: "session_1",
  input: "What's the latest status?"
})) {
  if (event.type === "token") {
    process.stdout.write(String(event.data));
  }
  if (event.type === "tool_call") {
    console.log("tool", event.data);
  }
}
```

The stream emits public events only: `start`, `tool_call`, `token`, `done`, and `error`.

## App Updates Without Redownloading

The VPS/local worker is for upgrading and operating the harness, not for every end user. Your app can opt into runtime-delivered updates by exposing a webhook and adding update config:

```ts
const harness = RecursiveHarness.create({
  appId: "my-product",
  runtimeUrl: "local",
  apiKey: "dev",
  optimization: "retention",
  autonomy: "full",
  updates: {
    webhookUrl: "https://my-product.com/api/harness-updates",
    apiKey: "host-update-secret",
    channel: "production"
  }
});

await harness.sendUpdate({
  title: "Enable compact chat",
  description: "Switch chat controls to the compact layout.",
  kind: "ui_config",
  payload: { compactChat: true }
});
```

Your host app decides how to apply the update. The SDK sends structured update packages; it does not force arbitrary code into user devices.

## Training Data Export

Export conversation pairs and outcomes as JSONL for later model training or fine-tuning pipelines:

```ts
const exportResult = await harness.exportTrainingData({
  path: "./exports/training.jsonl",
  includeExperience: true
});

console.log(exportResult.count);
```

## Runtime Server

```bash
npm run dev:runtime
```

Set `RECURSIVE_HARNESS_API_KEY` to require bearer-token auth for `/v1/*` routes.

The server exposes:

- `POST /v1/run`
- `POST /v1/tools`
- `POST /v1/events`
- `GET /v1/successor/active`
- `GET /v1/successor/history`
- `POST /v1/recursion/tick`
- `POST /v1/recursion/rollback-check`
- `GET /v1/status?range=24h`
- `GET /v1/status?range=7d`
- `GET /v1/stream?range=24h`
- `POST /v1/steer`
- `POST /v1/search`
- `POST /v1/lifecycle`
- `POST /v1/agent/summary`
- `POST /v1/local-workers/heartbeat`
- `POST /v1/local-workers/:id/tasks`
- `GET /v1/local-workers/:id/tasks/next`
- `POST /v1/local-workers/:id/tasks/:taskId/result`

Open `http://localhost:4317/?range=24h` or `http://localhost:4317/?range=7d` for the status dashboard.

The Cloudflare dashboard also shows:

- **Public planning stream**: public actions, plans, summaries, steering messages, and task updates. It does not expose hidden chain-of-thought.
- **Lifecycle phase**: `developing`, `almost_done_for_deployment`, or `production`.
- **Steering form**: paste the runtime API key and send an operator instruction to `/v1/steer`.
- **TinyFish current-data search**: paste the runtime API key and run `/v1/search` for up-to-date external information. Results are stored in the public stream.
- **Sandbox status**: Cloudflare Worker isolate plus optional local worker. This is not a full VM.

## 24/7 Cloud Control Plane

This project includes a Cloudflare Worker target for an always-reachable free-tier control plane:

```bash
npm install
npx wrangler kv namespace create HARNESS_STATE
```

Copy the created KV namespace id into `wrangler.jsonc`, then set secrets:

```bash
npx wrangler secret put RECURSIVE_HARNESS_API_KEY
npx wrangler secret put OLLAMA_API_KEY
npx wrangler secret put TINYFISH_API_KEY
```

Deploy:

```bash
npx wrangler deploy
```

The Worker uses Cloudflare Cron Triggers every 5 hours to write a summary. It is not a permanently running VM; it is an always-reachable serverless control plane that wakes on HTTP requests and scheduled events.

## Local Computer Worker

Run this on your computer when you want the cloud/runtime to execute queued tasks locally:

```powershell
$env:RECURSIVE_RUNTIME_URL="https://your-worker.your-subdomain.workers.dev"
$env:RECURSIVE_HARNESS_API_KEY="same_runtime_key_as_cloud"
$env:RECURSIVE_LOCAL_WORKER_ID="lenovo-pc"
$env:RECURSIVE_LOCAL_WORKER_NAME="Lenovo local worker"
npm run dev:local-worker
```

The cloud can queue tasks, and the local worker pulls them while your computer is on. No inbound port to your computer is required.

## AWS VPS Worker

The deployed control plane can also use an always-on AWS VPS worker.

Example worker:

- Worker id: `my-vps`
- Host: `your-vps-public-ip`
- Service: `sparky-harness-worker.service`
- Work dir: `/opt/sparky-harness-worker/work`
- Capabilities: `bash`, `node`

Useful SSH checks:

```bash
ssh -i "C:\path\to\your-vps-key.pem" ubuntu@your-vps-public-ip
sudo systemctl status sparky-harness-worker.service
sudo journalctl -u sparky-harness-worker.service -f
```

The VPS worker polls Cloudflare over outbound HTTPS and runs queued `bash`/`node` tasks as the `ubuntu` user. No public app port is required on the VPS.

For a one-shot check that starts, polls once, executes one queued task, and exits:

```powershell
$env:RECURSIVE_LOCAL_WORKER_ONCE="1"
npm run dev:local-worker
```

## Verification Helpers

Run the local end-to-end smoke without leaving a server running:

```bash
npm run smoke:local
```

This queues a local task, pulls it through the worker API, marks it complete, writes a 5-hour summary, and checks that the dashboard HTML renders.

## What Is Recursive Here?

The stable SDK does not inspect host source code. It passes declared tools, app state snapshots, user traces, and outcomes to the runtime. The runtime converts those traces into reflection findings, generates a successor runtime image artifact with lineage metadata, evaluates it against replayed sessions and retention/frustration signals, and promotes it when its score beats the active image.
