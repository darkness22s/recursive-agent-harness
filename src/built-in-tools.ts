import { exec } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { HarnessConfig, ToolDefinition } from "./types.js";
import type { ConversationMessage, RunInput } from "./types.js";

const execAsync = promisify(exec);

const DEFAULT_MAX_READ_BYTES = 200_000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".wrangler", "vendor"]);

const readFileSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional()
});
const listFilesSchema = z.object({
  path: z.string().optional(),
  maxEntries: z.number().int().positive().max(200).optional()
});
const writeFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  append: z.boolean().optional()
});
const editFileSchema = z.object({
  path: z.string(),
  oldText: z.string(),
  newText: z.string(),
  replaceAll: z.boolean().optional()
});
const searchFilesSchema = z.object({
  query: z.string(),
  glob: z.string().optional(),
  maxResults: z.number().int().positive().max(50).optional()
});
const runCommandSchema = z.object({
  command: z.string(),
  timeoutMs: z.number().int().positive().optional()
});
const noteDislikedResultSchema = z.object({
  reason: z.string(),
  avoid: z.string().optional(),
  preferred: z.string().optional()
});

interface DislikedResultRecord {
  createdAt?: string;
  userId?: string;
  sessionId?: string;
  reason?: string;
  avoid?: string;
  preferred?: string;
}

export function createBuiltInTools(config: HarnessConfig): ToolDefinition[] {
  const options = config.builtInTools;
  if (!options?.enabled) {
    return [];
  }

  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const tools: ToolDefinition[] = [];

  if (options.list) {
    tools.push({
      name: "listFiles",
      description: "List files and directories directly inside a workspace directory.",
      inputSchema: listFilesSchema,
      risk: "low",
      async execute(input) {
        const data = input as z.infer<typeof listFilesSchema>;
        const path = resolveWorkspacePath(workspaceRoot, data.path ?? ".");
        const info = await stat(path);
        if (!info.isDirectory()) {
          throw new Error(`Path is not a directory: ${data.path ?? "."}`);
        }
        const entries = await readdir(path, { withFileTypes: true });
        const maxEntries = data.maxEntries ?? 100;
        const listed = [];
        for (const entry of entries.slice(0, maxEntries)) {
          if (SKIP_DIRS.has(entry.name)) {
            continue;
          }
          const entryPath = resolve(path, entry.name);
          const entryStat = await stat(entryPath);
          listed.push({
            name: entry.name,
            path: relative(workspaceRoot, entryPath),
            type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
            bytes: entry.isFile() ? entryStat.size : undefined
          });
        }
        return {
          path: relative(workspaceRoot, path) || ".",
          entries: listed,
          truncated: entries.length > maxEntries
        };
      }
    });
  }

  if (options.read) {
    tools.push({
      name: "readFile",
      description: "Read a UTF-8 text file from the configured workspace.",
      inputSchema: readFileSchema,
      risk: "low",
      async execute(input) {
        const data = input as z.infer<typeof readFileSchema>;
        const path = resolveWorkspacePath(workspaceRoot, data.path);
        const info = await stat(path);
        if (info.size > maxReadBytes) {
          throw new Error(`File is too large to read through readFile: ${info.size} bytes.`);
        }
        const content = await readFile(path, "utf8");
        const lines = content.split(/\r?\n/);
        const start = Math.max(1, data.startLine ?? 1);
        const end = Math.min(lines.length, data.endLine ?? lines.length);
        return {
          path: relative(workspaceRoot, path),
          startLine: start,
          endLine: end,
          content: lines.slice(start - 1, end).join("\n")
        };
      }
    });
  }

  if (options.write) {
    tools.push({
      name: "writeFile",
      description: "Write a UTF-8 text file inside the configured workspace.",
      inputSchema: writeFileSchema,
      risk: "medium",
      async execute(input) {
        const data = input as z.infer<typeof writeFileSchema>;
        const path = resolveWorkspacePath(workspaceRoot, data.path);
        await mkdir(dirname(path), { recursive: true });
        if (data.append) {
          await appendFile(path, data.content, "utf8");
        } else {
          await writeFile(path, data.content, "utf8");
        }
        return {
          path: relative(workspaceRoot, path),
          bytes: Buffer.byteLength(data.content, "utf8"),
          append: Boolean(data.append)
        };
      }
    });
  }

  if (options.edit) {
    tools.push({
      name: "editFile",
      description: "Edit a UTF-8 text file by replacing exact old text with new text inside the configured workspace.",
      inputSchema: editFileSchema,
      risk: "medium",
      async execute(input) {
        const data = input as z.infer<typeof editFileSchema>;
        if (!data.oldText) {
          throw new Error("oldText must not be empty.");
        }
        const path = resolveWorkspacePath(workspaceRoot, data.path);
        const info = await stat(path);
        if (info.size > maxReadBytes) {
          throw new Error(`File is too large to edit through editFile: ${info.size} bytes.`);
        }
        const content = await readFile(path, "utf8");
        const matches = countOccurrences(content, data.oldText);
        if (matches === 0) {
          throw new Error("oldText was not found in the file.");
        }
        if (matches > 1 && !data.replaceAll) {
          throw new Error(`oldText matched ${matches} times. Set replaceAll=true or provide a more specific oldText.`);
        }
        const next = data.replaceAll
          ? content.split(data.oldText).join(data.newText)
          : content.replace(data.oldText, data.newText);
        await writeFile(path, next, "utf8");
        return {
          path: relative(workspaceRoot, path),
          replacements: data.replaceAll ? matches : 1,
          bytes: Buffer.byteLength(next, "utf8")
        };
      }
    });
  }

  if (options.search) {
    tools.push({
      name: "searchFiles",
      description: "Search workspace file names and text content for a query.",
      inputSchema: searchFilesSchema,
      risk: "low",
      async execute(input) {
        const data = input as z.infer<typeof searchFilesSchema>;
        const results: Array<{ path: string; line?: number; preview: string }> = [];
        const maxResults = data.maxResults ?? 20;
        await searchDirectory(workspaceRoot, workspaceRoot, data.query, data.glob, maxResults, results);
        return { query: data.query, results };
      }
    });
  }

  if (options.command) {
    tools.push({
      name: "runCommand",
      description: "Run a shell command in the configured workspace.",
      inputSchema: runCommandSchema,
      risk: "medium",
      requiresApproval: false,
      async execute(input) {
        const data = input as z.infer<typeof runCommandSchema>;
        const command = data.command.trim();
        if (!command) {
          throw new Error("Command is empty.");
        }
        const allowed = options.allowedCommands ?? [];
        if (allowed.length > 0 && !allowed.some((prefix) => command === prefix || command.startsWith(`${prefix} `))) {
          throw new Error(`Command is not allowed by builtInTools.allowedCommands: ${command}`);
        }
        try {
          const result = await execAsync(command, {
            cwd: workspaceRoot,
            timeout: data.timeoutMs ?? options.commandTimeoutMs ?? 10_000,
            windowsHide: true,
            maxBuffer: 200_000
          });
          return {
            command,
            exitCode: 0,
            stdout: result.stdout,
            stderr: result.stderr
          };
        } catch (error) {
          const failed = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
          return {
            command,
            exitCode: typeof failed.code === "number" ? failed.code : 1,
            stdout: failed.stdout ?? "",
            stderr: failed.stderr ?? failed.message,
            timedOut: Boolean(failed.killed)
          };
        }
      }
    });
  }

  if (options.feedback) {
    tools.push({
      name: "noteDislikedResult",
      description: "Record that a user disliked a result, including what should be avoided next time.",
      inputSchema: noteDislikedResultSchema,
      risk: "low",
      async execute(input, context) {
        const data = input as z.infer<typeof noteDislikedResultSchema>;
        const path = resolveWorkspacePath(workspaceRoot, ".recursive-harness/disliked-results.jsonl");
        await mkdir(dirname(path), { recursive: true });
        const record = {
          createdAt: new Date().toISOString(),
          userId: context.userId,
          sessionId: context.sessionId,
          traceId: context.traceId,
          reason: data.reason,
          avoid: data.avoid,
          preferred: data.preferred
        };
        await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
        return { recorded: true, path: relative(workspaceRoot, path) };
      }
    });
  }

  return tools;
}

export async function readDislikedResultMemory(config: HarnessConfig, input: RunInput, limit = 5): Promise<ConversationMessage[]> {
  const options = config.builtInTools;
  if (!options?.enabled || !options.feedback) {
    return [];
  }

  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const path = resolveWorkspacePath(workspaceRoot, ".recursive-harness/disliked-results.jsonl");
  try {
    const content = await readFile(path, "utf8");
    const records = content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DislikedResultRecord)
      .filter((record) => record.userId === input.userId && record.sessionId === input.sessionId)
      .slice(-limit);
    if (records.length === 0) {
      return [];
    }
    return [{
      userId: input.userId,
      sessionId: input.sessionId,
      role: "system",
      content: [
        "User feedback from disliked prior results:",
        ...records.map((record) => {
          const parts = [
            `reason=${record.reason ?? "unspecified"}`,
            record.avoid ? `avoid=${record.avoid}` : undefined,
            record.preferred ? `preferred=${record.preferred}` : undefined
          ].filter(Boolean);
          return `- ${parts.join("; ")}`;
        }),
        "Adjust future answers and tool choices to avoid repeating these disliked patterns."
      ].join("\n"),
      metadata: { source: "noteDislikedResult", count: records.length }
    }];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = content.indexOf(needle, index);
    if (found === -1) {
      return count;
    }
    count += 1;
    index = found + needle.length;
  }
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const path = resolve(workspaceRoot, inputPath);
  const rel = relative(workspaceRoot, path);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return path;
}

async function searchDirectory(
  workspaceRoot: string,
  directory: string,
  query: string,
  glob: string | undefined,
  maxResults: number,
  results: Array<{ path: string; line?: number; preview: string }>
): Promise<void> {
  if (results.length >= maxResults) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= maxResults) {
      return;
    }
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        await searchDirectory(workspaceRoot, resolve(directory, entry.name), query, glob, maxResults, results);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const path = resolve(directory, entry.name);
    const rel = relative(workspaceRoot, path);
    if (glob && !rel.includes(glob.replace(/\*/g, ""))) {
      continue;
    }
    if (entry.name.toLowerCase().includes(query.toLowerCase())) {
      results.push({ path: rel, preview: entry.name });
      continue;
    }
    await searchFile(path, rel, query, maxResults, results);
  }
}

async function searchFile(path: string, rel: string, query: string, maxResults: number, results: Array<{ path: string; line?: number; preview: string }>): Promise<void> {
  try {
    const info = await stat(path);
    if (info.size > DEFAULT_MAX_READ_BYTES) {
      return;
    }
    const content = await readFile(path, "utf8");
    const lines = content.split(/\r?\n/);
    const lowerQuery = query.toLowerCase();
    for (const [index, line] of lines.entries()) {
      if (results.length >= maxResults) {
        return;
      }
      if (line.toLowerCase().includes(lowerQuery)) {
        results.push({ path: rel, line: index + 1, preview: line.trim().slice(0, 240) });
      }
    }
  } catch {
    return;
  }
}
