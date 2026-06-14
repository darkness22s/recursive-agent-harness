import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConversationMessage, ExperienceEvent, TrainingExportOptions } from "./types.js";

export interface TrainingExportInput {
  conversations: ConversationMessage[];
  experienceEvents: ExperienceEvent[];
  options?: TrainingExportOptions;
}

export interface TrainingExportResult {
  format: "jsonl";
  count: number;
  content: string;
  path?: string;
}

export async function exportTrainingData(input: TrainingExportInput): Promise<TrainingExportResult> {
  const options = input.options ?? {};
  const includeExperience = options.includeExperience ?? true;
  const records = buildTrainingRecords(input.conversations, includeExperience ? input.experienceEvents : []);
  const content = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");

  if (options.path) {
    await mkdir(dirname(options.path), { recursive: true });
    await writeFile(options.path, content, "utf8");
  }

  return {
    format: "jsonl",
    count: records.length,
    content,
    path: options.path
  };
}

function buildTrainingRecords(conversations: ConversationMessage[], events: ExperienceEvent[]) {
  const bySession = new Map<string, ConversationMessage[]>();
  for (const message of conversations) {
    const key = `${message.userId}:${message.sessionId}`;
    bySession.set(key, [...(bySession.get(key) ?? []), message]);
  }

  const records = [...bySession.values()].flatMap((messages) => {
    const sorted = [...messages].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    const pairs = [];
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const prompt = sorted[index];
      const completion = sorted[index + 1];
      if (prompt.role === "user" && completion.role === "assistant") {
        pairs.push({
          messages: [
            { role: "user", content: prompt.content },
            { role: "assistant", content: completion.content }
          ],
          metadata: {
            userId: prompt.userId,
            sessionId: prompt.sessionId,
            createdAt: completion.createdAt
          }
        });
      }
    }
    return pairs;
  });

  return records.map((record) => {
    const matching = events.find((event) => event.userId === record.metadata.userId && event.sessionId === record.metadata.sessionId);
    return matching ? { ...record, outcome: matching.outcome, sentimentSignals: matching.sentimentSignals } : record;
  });
}
