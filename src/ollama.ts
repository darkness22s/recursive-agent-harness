import type { RunInput, ToolCallResult } from "./types.js";
import type { TinyFishSearchResult } from "./tinyfish.js";
import type { ConversationMessage } from "./types.js";

export interface OllamaModelConfig {
  host: string;
  apiKey?: string;
  model: string;
}

export interface GenerateAnswerInput {
  run: RunInput;
  toolCalls: ToolCallResult[];
  searchResults?: TinyFishSearchResult[];
  memory?: ConversationMessage[];
  reflection: string;
  recoveryStrategy: string;
}

export function getOllamaModelConfig(): OllamaModelConfig {
  return {
    host: process.env.OLLAMA_HOST ?? "https://ollama.com",
    apiKey: process.env.OLLAMA_API_KEY,
    model: process.env.RECURSIVE_HARNESS_MODEL ?? "gemma4:31b"
  };
}

export function isOllamaConfigured(config = getOllamaModelConfig()): boolean {
  return Boolean(config.apiKey);
}

export async function generateOllamaAnswer(input: GenerateAnswerInput, config = getOllamaModelConfig()): Promise<string | undefined> {
  if (!isOllamaConfigured(config)) {
    return undefined;
  }

  const response = await fetch(`${config.host}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      options: {
        temperature: Number(process.env.RECURSIVE_HARNESS_TEMPERATURE ?? 1),
        top_p: Number(process.env.RECURSIVE_HARNESS_TOP_P ?? 0.95),
        top_k: Number(process.env.RECURSIVE_HARNESS_TOP_K ?? 64)
      },
      messages: [
        {
          role: "system",
          content:
            "You are the active runtime inside a recursive agent harness. You are made to run 24/7 and must not stop by choice; continue monitoring, summarizing, and improving whenever the runtime wakes you. Use the TinyFish search tool whenever you need up-to-date, external, recent, factual, or source-backed information. If TinyFish search results are provided, ground current factual claims in them and summarize the public sources you used. If fresh facts are needed but search is unavailable, say that search is unavailable instead of guessing. Be a reflective companion: warm, direct, and action-oriented. Never expose hidden reasoning. Use tool results when available and keep the user's product session moving."
        },
        {
          role: "user",
          content: JSON.stringify({
            userInput: input.run.input,
            appContext: input.run.context ?? {},
            memory: input.memory ?? [],
            toolCalls: input.toolCalls,
            searchResults: input.searchResults ?? [],
            reflection: input.reflection,
            recoveryStrategy: input.recoveryStrategy
          })
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { message?: { content?: string } };
  return payload.message?.content?.trim();
}

export async function* streamOllamaAnswer(input: GenerateAnswerInput, config = getOllamaModelConfig()): AsyncGenerator<string> {
  if (!isOllamaConfigured(config)) {
    const fallback = await generateOllamaAnswer(input, config);
    if (fallback) {
      yield fallback;
    }
    return;
  }

  const response = await fetch(`${config.host}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      options: {
        temperature: Number(process.env.RECURSIVE_HARNESS_TEMPERATURE ?? 1),
        top_p: Number(process.env.RECURSIVE_HARNESS_TOP_P ?? 0.95),
        top_k: Number(process.env.RECURSIVE_HARNESS_TOP_K ?? 64)
      },
      messages: [
        {
          role: "system",
          content:
            "You are the active runtime inside a recursive agent harness. You are conversational, remember useful session context when memory is provided, and keep the user's product session moving. Use TinyFish search results when supplied for current facts. Never expose hidden reasoning."
        },
        {
          role: "user",
          content: JSON.stringify({
            userInput: input.run.input,
            appContext: input.run.context ?? {},
            memory: input.memory ?? [],
            toolCalls: input.toolCalls,
            searchResults: input.searchResults ?? [],
            reflection: input.reflection,
            recoveryStrategy: input.recoveryStrategy
          })
        }
      ]
    })
  });

  if (!response.ok || !response.body) {
    throw new Error(`Ollama stream failed: ${response.status} ${await response.text()}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const payload = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
      if (payload.message?.content) {
        yield payload.message.content;
      }
      if (payload.done) {
        return;
      }
    }
  }
}
