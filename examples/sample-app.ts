import { z } from "zod";
import { RecursiveHarness } from "../src/index.js";

const harness = RecursiveHarness.create({
  appId: "sample-product",
  runtimeUrl: "local",
  apiKey: "dev",
  optimization: "retention",
  autonomy: "full"
});

harness.registerTool({
  name: "createProject",
  description: "Creates a project for the current user",
  inputSchema: z.object({ name: z.string() }),
  execute: async (input, context) => ({
    id: `project_${input.name.toLowerCase().replace(/\s+/g, "_")}`,
    owner: context.userId,
    name: input.name
  })
});

const result = await harness.run({
  userId: "user_1",
  sessionId: "session_1",
  input: "createProject 'Apollo'",
  context: { plan: "pro" }
});

harness.trackExperience({
  userId: "user_1",
  sessionId: "session_1",
  message: "that worked",
  response: result.output,
  outcome: "continued"
});

console.log(result);
