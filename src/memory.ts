import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import type { ConversationMessage, HarnessConfig } from "./types.js";

export interface MemoryReadOptions {
  userId: string;
  sessionId: string;
  limit?: number;
}

export class FileConversationMemory {
  constructor(private readonly directory: string, private readonly maxMessagesPerSession = 40) {}

  async append(message: ConversationMessage): Promise<ConversationMessage> {
    const saved: ConversationMessage = {
      ...message,
      id: message.id ?? nanoid(),
      createdAt: message.createdAt ?? new Date().toISOString()
    };
    const path = this.pathFor(message.userId, message.sessionId);
    await mkdir(dirname(path), { recursive: true });
    const existing = await this.read({ userId: message.userId, sessionId: message.sessionId, limit: this.maxMessagesPerSession });
    const next = [...existing, saved].slice(-this.maxMessagesPerSession);
    await writeFile(path, `${next.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    return saved;
  }

  async read(options: MemoryReadOptions): Promise<ConversationMessage[]> {
    const path = this.pathFor(options.userId, options.sessionId);
    try {
      const content = await readFile(path, "utf8");
      const messages = content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ConversationMessage);
      return messages.slice(-(options.limit ?? this.maxMessagesPerSession));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private pathFor(userId: string, sessionId: string): string {
    return join(this.directory, safePath(userId), `${safePath(sessionId)}.jsonl`);
  }
}

export function createMemoryFromConfig(config: HarnessConfig): FileConversationMemory | undefined {
  if (config.memory?.kind !== "file") {
    return undefined;
  }
  return new FileConversationMemory(config.memory.directory, config.memory.maxMessagesPerSession);
}

function safePath(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}
