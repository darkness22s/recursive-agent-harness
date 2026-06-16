import { toJSONSchema, type z } from "zod";
import type { ToolDefinition, ToolManifest } from "./types.js";

export function toolToManifest(tool: Pick<ToolDefinition, "name" | "description" | "inputSchema" | "risk" | "requiresApproval">): ToolManifest {
  return {
    name: tool.name,
    description: tool.description,
    schema: schemaToManifest(tool.inputSchema),
    risk: tool.risk,
    requiresApproval: tool.requiresApproval
  };
}

export function schemaToManifest(schema: z.ZodType): unknown {
  try {
    return {
      kind: "json-schema",
      schema: toJSONSchema(schema)
    };
  } catch {
    return {
      kind: "zod",
      description: schema.description ?? "Runtime-provided schema"
    };
  }
}
