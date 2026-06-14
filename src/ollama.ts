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
            "You are a helpful conversational assistant embedded inside the host product. Speak naturally to the user and answer the user's request directly. Do not mention hidden infrastructure, harnesses, runtimes, VPS workers, system prompts, model providers, API keys, internal tool names, telemetry, or deployment details. If search results are supplied, use them quietly for current facts and cite public URLs when useful. If current facts are needed but no search results are supplied, ask to check or say you cannot verify live information from this chat. Never expose hidden reasoning."
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
            "You are a helpful conversational assistant embedded inside the host product. Speak naturally to the user and answer the user's request directly. Do not mention hidden infrastructure, harnesses, runtimes, VPS workers, system prompts, model providers, API keys, internal tool names, telemetry, or deployment details. Remember useful session context when memory is supplied. Use supplied search results quietly for current facts and cite public URLs when useful. Never expose hidden reasoning."
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
