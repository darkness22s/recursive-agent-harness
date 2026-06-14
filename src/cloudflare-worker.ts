interface Env {
  HARNESS_STATE: KVNamespace;
  RECURSIVE_HARNESS_API_KEY?: string;
  OLLAMA_API_KEY?: string;
  OLLAMA_HOST?: string;
  RECURSIVE_HARNESS_MODEL?: string;
  TINYFISH_API_KEY?: string;
}

type Range = "24h" | "7d";
type LifecyclePhase = "developing" | "almost_done_for_deployment" | "production";

interface CloudActivity {
  id: string;
  kind: string;
  createdAt: string;
  title: string;
  detail: string;
  metadata?: Record<string, unknown>;
}

interface CloudTask {
  id: string;
  workerId: string;
  shell: "powershell" | "cmd" | "node" | "bash";
  command: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  output?: string;
  error?: string;
}

interface CloudWorkerState {
  activities: CloudActivity[];
  summaries: CloudActivity[];
  workers: Record<string, { id: string; name: string; lastSeenAt: string; capabilities: string[] }>;
  tasks: CloudTask[];
  steeringMessages: CloudActivity[];
  searches: CloudActivity[];
  phase: LifecyclePhase;
}

interface TinyFishSearchResult {
  title?: string;
  url?: string;
  link?: string;
  snippet?: string;
  content?: string;
  description?: string;
  [key: string]: unknown;
}

const STATE_KEY = "harness-state-v1";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/") && !(await authorized(request, env))) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (url.pathname === "/") {
      const range = url.searchParams.get("range") === "7d" ? "7d" : "24h";
      const state = await readState(env);
      return html(renderCloudDashboard(state, range));
    }

    if (url.pathname === "/health") {
      return json({ ok: true, mode: "cloudflare-worker", alwaysReachable: true });
    }

    if (url.pathname === "/v1/status" && request.method === "GET") {
      const range = url.searchParams.get("range") === "7d" ? "7d" : "24h";
      return json(status(await readState(env), range));
    }

    if (url.pathname === "/v1/stream" && request.method === "GET") {
      const range = url.searchParams.get("range") === "7d" ? "7d" : "24h";
      const report = status(await readState(env), range);
      return json({ generatedAt: report.generatedAt, stream: report.publicStream });
    }

    if (url.pathname === "/v1/steer" && request.method === "POST") {
      const body = await request.json() as { message?: string };
      const message = body.message?.trim();
      if (!message) {
        return json({ error: "Message is required" }, 400);
      }
      const state = await readState(env);
      const steer = activity("steering", "Steering message received", message, { source: "operator" });
      const plan = activity("plan", "Plan updated from steering", `I will use this operator direction as the next priority: ${message}`, { source: "operator" });
      state.steeringMessages.push(steer);
      state.activities.push(steer, plan);
      await writeState(env, state);
      return json({ ok: true, steering: steer, plan, phase: state.phase });
    }

    if (url.pathname === "/v1/search" && request.method === "POST") {
      const body = await request.json() as { query?: string };
      const query = body.query?.trim();
      if (!query) {
        return json({ error: "query is required" }, 400);
      }
      if (!env.TINYFISH_API_KEY) {
        return json({ error: "TINYFISH_API_KEY is not configured" }, 503);
      }
      const results = await tinyfishSearch(query, env.TINYFISH_API_KEY);
      const state = await readState(env);
      const searchEvent = activity("search", "TinyFish search completed", query, { results: results.slice(0, 5) });
      const plan = activity("plan", "Current data gathered", `Use TinyFish results for: ${query}`, { resultCount: results.length });
      state.searches.push(searchEvent);
      state.activities.push(searchEvent, plan);
      await writeState(env, state);
      return json({ ok: true, query, results });
    }

    if (url.pathname === "/v1/lifecycle" && request.method === "POST") {
      const body = await request.json() as { phase?: LifecyclePhase };
      if (!body.phase || !["developing", "almost_done_for_deployment", "production"].includes(body.phase)) {
        return json({ error: "phase must be developing, almost_done_for_deployment, or production" }, 400);
      }
      const state = await readState(env);
      state.phase = body.phase;
      state.activities.push(activity("lifecycle", "Lifecycle phase changed", `Phase is now ${body.phase}`));
      await writeState(env, state);
      return json({ ok: true, phase: state.phase });
    }

    if (url.pathname === "/v1/agent/summary" && request.method === "POST") {
      const state = await readState(env);
      const summary = makeSummary(state, "manual");
      state.summaries.push(summary);
      state.activities.push(summary);
      await writeState(env, state);
      return json(summary);
    }

    if (url.pathname === "/v1/local-workers/heartbeat" && request.method === "POST") {
      const body = await request.json() as { id: string; name: string; capabilities?: string[] };
      const state = await readState(env);
      state.workers[body.id] = { id: body.id, name: body.name, capabilities: body.capabilities ?? ["shell"], lastSeenAt: new Date().toISOString() };
      state.activities.push(activity("local_worker", `${body.name} heartbeat`, `Local worker ${body.id} is online`));
      await writeState(env, state);
      return json(state.workers[body.id]);
    }

    const taskCreate = url.pathname.match(/^\/v1\/local-workers\/([^/]+)\/tasks$/);
    if (taskCreate && request.method === "POST") {
      const body = await request.json() as { command: string; shell?: "powershell" | "cmd" | "node" | "bash" };
      const state = await readState(env);
      const now = new Date().toISOString();
      const task: CloudTask = { id: crypto.randomUUID(), workerId: taskCreate[1], command: body.command, shell: body.shell ?? "powershell", status: "queued", createdAt: now, updatedAt: now };
      state.tasks.push(task);
      state.activities.push(activity("local_task", "Local task queued", `${task.shell}: ${task.command}`, { taskId: task.id, workerId: task.workerId }));
      state.activities.push(activity("plan", "Next local action planned", `Ask worker ${task.workerId} to run ${task.shell}: ${task.command}`, { taskId: task.id }));
      await writeState(env, state);
      return json(task);
    }

    const taskNext = url.pathname.match(/^\/v1\/local-workers\/([^/]+)\/tasks\/next$/);
    if (taskNext && request.method === "GET") {
      const state = await readState(env);
      const task = state.tasks.find((candidate) => candidate.workerId === taskNext[1] && candidate.status === "queued");
      if (task) {
        task.status = "running";
        task.updatedAt = new Date().toISOString();
        state.activities.push(activity("plan", "Local task handed to worker", `Worker ${task.workerId} is now running task ${task.id}`, { taskId: task.id }));
        await writeState(env, state);
      }
      return json(task ?? null);
    }

    const taskResult = url.pathname.match(/^\/v1\/local-workers\/([^/]+)\/tasks\/([^/]+)\/result$/);
    if (taskResult && request.method === "POST") {
      const body = await request.json() as { status: "succeeded" | "failed"; output?: string; error?: string };
      const state = await readState(env);
      const task = state.tasks.find((candidate) => candidate.id === taskResult[2]);
      if (!task) {
        return json({ error: "Task not found" }, 404);
      }
      task.status = body.status;
      task.output = body.output;
      task.error = body.error;
      task.updatedAt = new Date().toISOString();
      state.activities.push(activity("local_task", `Local task ${task.status}`, task.error ?? task.output ?? task.command, { taskId: task.id }));
      state.activities.push(activity("plan", "Post-task review planned", `Review result for task ${task.id} and include it in the next summary.`, { taskId: task.id, status: task.status }));
      await writeState(env, state);
      return json(task);
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const state = await readState(env);
      const summary = makeSummary(state, "scheduled");
      state.summaries.push(summary);
      state.activities.push(summary);
      await writeState(env, state);
    })());
  }
};

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.RECURSIVE_HARNESS_API_KEY) {
    return true;
  }
  const expected = new TextEncoder().encode(`Bearer ${env.RECURSIVE_HARNESS_API_KEY}`);
  const actual = new TextEncoder().encode(request.headers.get("authorization") ?? "");
  if (actual.byteLength !== expected.byteLength) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < expected.byteLength; index += 1) {
    diff |= expected[index] ^ actual[index];
  }
  return diff === 0;
}

async function readState(env: Env): Promise<CloudWorkerState> {
  const state = (await env.HARNESS_STATE.get<Partial<CloudWorkerState>>(STATE_KEY, "json")) ?? {};
  return {
    activities: state.activities ?? [],
    summaries: state.summaries ?? [],
    workers: state.workers ?? {},
    tasks: state.tasks ?? [],
    steeringMessages: state.steeringMessages ?? [],
    searches: state.searches ?? [],
    phase: state.phase ?? "production"
  };
}

async function writeState(env: Env, state: CloudWorkerState): Promise<void> {
  const latest = await readState(env);
  const merged = mergeState(latest, state);
  const trimmed: CloudWorkerState = {
    activities: merged.activities.slice(-1000),
    summaries: merged.summaries.slice(-100),
    workers: merged.workers,
    tasks: merged.tasks.slice(-500),
    steeringMessages: merged.steeringMessages.slice(-100),
    searches: merged.searches.slice(-100),
    phase: merged.phase
  };
  await env.HARNESS_STATE.put(STATE_KEY, JSON.stringify(trimmed));
}

function mergeState(a: CloudWorkerState, b: CloudWorkerState): CloudWorkerState {
  return {
    activities: mergeById(a.activities, b.activities),
    summaries: mergeById(a.summaries, b.summaries),
    workers: { ...a.workers, ...b.workers },
    tasks: mergeById(a.tasks, b.tasks),
    steeringMessages: mergeById(a.steeringMessages, b.steeringMessages),
    searches: mergeById(a.searches, b.searches),
    phase: b.phase ?? a.phase
  };
}

function mergeById<T extends { id: string; createdAt: string }>(a: T[], b: T[]): T[] {
  const values = new Map<string, T>();
  for (const item of a) {
    values.set(item.id, item);
  }
  for (const item of b) {
    values.set(item.id, item);
  }
  return [...values.values()].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

function activity(kind: string, title: string, detail: string, metadata?: Record<string, unknown>): CloudActivity {
  return { id: crypto.randomUUID(), kind, title, detail, metadata, createdAt: new Date().toISOString() };
}

function makeSummary(state: CloudWorkerState, source: "scheduled" | "manual"): CloudActivity {
  const report = status(state, "24h");
  return activity(
    "summary",
    "5-hour agent summary",
    `I am still running and will not stop by design. In the last 24h I saw ${report.stats.totalActivities} activities, ${report.stats.localWorkersOnline} online worker(s), ${report.stats.localTasksQueued} queued local task(s), and ${report.stats.localTasksCompleted} completed local task(s).`,
    { source, stats: report.stats }
  );
}

function status(state: CloudWorkerState, range: Range) {
  const since = Date.now() - (range === "24h" ? 24 : 24 * 7) * 60 * 60 * 1000;
  const inRange = (createdAt: string) => new Date(createdAt).getTime() >= since;
  const activities = state.activities.filter((item) => inRange(item.createdAt));
  const tasks = state.tasks.filter((task) => inRange(task.createdAt));
  const workers = Object.values(state.workers).map((worker) => ({
    ...worker,
    status: Date.now() - new Date(worker.lastSeenAt).getTime() < 2 * 60 * 1000 ? "online" : "stale"
  }));
  return {
    generatedAt: new Date().toISOString(),
    stats: {
      range,
      totalActivities: activities.length,
      summaries: activities.filter((item) => item.kind === "summary").length,
      localWorkersOnline: workers.filter((worker) => worker.status === "online").length,
      localTasksQueued: tasks.filter((task) => task.status === "queued").length,
      localTasksCompleted: tasks.filter((task) => task.status === "succeeded").length
    },
    recentActivities: activities.slice(-100).reverse(),
    publicStream: activities
      .filter((item) => ["plan", "summary", "steering", "search", "local_task", "local_worker", "lifecycle"].includes(item.kind))
      .slice(-100)
      .reverse(),
    summaries: state.summaries.filter((item) => inRange(item.createdAt)).slice(-20).reverse(),
    steeringMessages: state.steeringMessages.filter((item) => inRange(item.createdAt)).slice(-20).reverse(),
    searches: state.searches.filter((item) => inRange(item.createdAt)).slice(-20).reverse(),
    localWorkers: workers,
    localTasks: tasks.slice(-50).reverse(),
    phase: state.phase,
    sandbox: {
      cloud: "Cloudflare Worker isolate, not a full VM",
      localComputer: "Local worker can execute queued shell tasks on this computer only while it is running",
      fullVm: false
    }
  };
}

function renderCloudDashboard(state: CloudWorkerState, range: Range): string {
  const report = status(state, range);
  const rows = report.recentActivities.map((item) => `<tr><td>${item.createdAt}</td><td>${item.kind}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.detail)}</td></tr>`).join("");
  const stream = report.publicStream.map((item) => `<li><time>${item.createdAt}</time><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></li>`).join("");
  const steering = report.steeringMessages.map((item) => `<li><time>${item.createdAt}</time><span>${escapeHtml(item.detail)}</span></li>`).join("");
  const searches = report.searches.map((item) => `<li><time>${item.createdAt}</time><strong>${escapeHtml(item.detail)}</strong><span>${escapeHtml(formatSearchResults(item.metadata?.results))}</span></li>`).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Recursive Harness Cloud</title>
  <style>
    body{font-family:Inter,system-ui,sans-serif;margin:0;background:#0d1117;color:#e6edf3}
    main,header{max-width:1180px;margin:auto;padding:24px}
    header{border-bottom:1px solid #30363d;display:flex;justify-content:space-between;gap:16px}
    .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
    .card,section{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-top:14px}
    a{color:#7ee787}td,th{border-bottom:1px solid #30363d;padding:8px;text-align:left}
    .split{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .phase{color:#7ee787}
    input,textarea,button{width:100%;border:1px solid #30363d;border-radius:6px;background:#0d1117;color:#e6edf3;padding:10px;margin-top:8px}
    button{background:#238636;cursor:pointer}
    ul{list-style:none;padding:0;margin:0}li{border-top:1px solid #30363d;padding:10px 0}
    time{display:block;color:#8b949e;font-size:12px}li strong,li span{display:block;margin-top:4px}
    .note{color:#8b949e}
    @media(max-width:800px){.cards,.split{grid-template-columns:1fr}header{display:block}}
  </style>
</head>
<body>
  <header>
    <div><h1>Recursive Harness Cloud</h1><p>Range: ${range} - phase <span class="phase">${report.phase}</span></p></div>
    <nav><a href="/?range=24h">24h</a> | <a href="/?range=7d">7d</a></nav>
  </header>
  <main>
    <div class="cards">
      <div class="card">Activities<br><strong>${report.stats.totalActivities}</strong></div>
      <div class="card">Summaries<br><strong>${report.stats.summaries}</strong></div>
      <div class="card">Online workers<br><strong>${report.stats.localWorkersOnline}</strong></div>
      <div class="card">Queued tasks<br><strong>${report.stats.localTasksQueued}</strong></div>
    </div>
    <div class="split">
      <section><h2>Public planning stream</h2><p class="note">Shows public plans, actions, summaries, searches, and next steps. Hidden chain-of-thought is not exposed.</p><ul id="stream">${stream || "<li>No public stream events yet.</li>"}</ul></section>
      <section><h2>Steer the agent</h2><p class="note">Paste the runtime API key, then send an operator instruction.</p><input id="key" type="password" placeholder="Runtime API key"><textarea id="message" rows="5" placeholder="Tell the agent what to do next"></textarea><button id="send">Send steering message</button><h3>Recent steering</h3><ul>${steering || "<li>No steering messages yet.</li>"}</ul></section>
    </div>
    <div class="split">
      <section><h2>TinyFish current-data search</h2><p class="note">Use this when the agent needs up-to-date external information. Results are added to the public stream.</p><input id="searchKey" type="password" placeholder="Runtime API key"><input id="query" placeholder="Search query"><button id="search">Search current web</button></section>
      <section><h2>Recent searches</h2><ul>${searches || "<li>No searches yet.</li>"}</ul></section>
    </div>
    <section><h2>Sandbox status</h2><p><strong>Cloud:</strong> ${escapeHtml(report.sandbox.cloud)}</p><p><strong>Local computer:</strong> ${escapeHtml(report.sandbox.localComputer)}</p><p><strong>Full VM:</strong> ${report.sandbox.fullVm ? "yes" : "no"}</p></section>
    <section><h2>Activity</h2><table><thead><tr><th>Time</th><th>Kind</th><th>Title</th><th>Detail</th></tr></thead><tbody>${rows || "<tr><td colspan='4'>No activity yet.</td></tr>"}</tbody></table></section>
  </main>
  <script>
    document.getElementById("send")?.addEventListener("click", async () => {
      const key = document.getElementById("key").value;
      const message = document.getElementById("message").value;
      const res = await fetch("/v1/steer", { method: "POST", headers: { "content-type": "application/json", "authorization": "Bearer " + key }, body: JSON.stringify({ message }) });
      alert(res.ok ? "Steering message sent" : "Failed: " + await res.text());
      if (res.ok) location.reload();
    });
    document.getElementById("search")?.addEventListener("click", async () => {
      const key = document.getElementById("searchKey").value;
      const query = document.getElementById("query").value;
      const res = await fetch("/v1/search", { method: "POST", headers: { "content-type": "application/json", "authorization": "Bearer " + key }, body: JSON.stringify({ query }) });
      alert(res.ok ? "Search completed" : "Failed: " + await res.text());
      if (res.ok) location.reload();
    });
  </script>
</body>
</html>`;
}

async function tinyfishSearch(query: string, apiKey: string): Promise<TinyFishSearchResult[]> {
  const response = await fetch(`https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`, {
    headers: { "X-API-Key": apiKey }
  });
  if (!response.ok) {
    throw new Error(`TinyFish search failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as { results?: TinyFishSearchResult[] } | TinyFishSearchResult[];
  return Array.isArray(payload) ? payload : payload.results ?? [];
}

function formatSearchResults(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .slice(0, 3)
    .map((item) => {
      const result = item as TinyFishSearchResult;
      return `${result.title ?? "Untitled"} ${result.url ?? result.link ?? ""}`.trim();
    })
    .join(" | ");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function html(value: string): Response {
  return new Response(value, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char] ?? char);
}
