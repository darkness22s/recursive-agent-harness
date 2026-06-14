import { serve } from "@hono/node-server";
import { createRuntimeServer } from "../server.js";
import { RecursiveRuntime } from "../runtime.js";

const port = Number(process.env.PORT ?? 4317);
const runtime = new RecursiveRuntime();

serve({
  fetch: createRuntimeServer(runtime).fetch,
  port
});

setInterval(() => {
  runtime.createFiveHourSummary();
  runtime.tick();
}, 5 * 60 * 60 * 1000).unref();

console.log(`Recursive harness runtime listening on http://localhost:${port}`);
