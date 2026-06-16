import { createBuiltInTools } from "./built-in-tools.js";
import { detectAnger, detectProfanity } from "./detectors.js";
import { RuntimeHttpClient } from "./http-client.js";
import { RecursiveRuntime } from "./runtime.js";
import { toolToManifest } from "./tool-manifest.js";
import type {
  AppSnapshot,
  AppUpdatePackage,
  ExperienceEvent,
  HarnessConfig,
  RunInput,
  RunResult,
  StreamEvent,
  ToolDefinition,
  TrainingExportOptions
} from "./types.js";

export class RecursiveHarness {
  private readonly localRuntime?: RecursiveRuntime;
  private readonly httpClient?: RuntimeHttpClient;

  private constructor(private readonly config: HarnessConfig) {
    if (config.runtimeUrl === "local") {
      this.localRuntime = getSharedLocalRuntime(config.appId);
      for (const tool of createBuiltInTools(config)) {
        this.registerTool(tool);
      }
    } else {
      this.httpClient = new RuntimeHttpClient(config);
    }
  }

  static create(config: HarnessConfig): RecursiveHarness {
    return new RecursiveHarness(config);
  }

  static resetLocalRuntimes(): void {
    sharedLocalRuntimes.clear();
  }

  registerTool<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void | Promise<{ ok: true }> {
    const manifest = toolToManifest(tool);

    if (this.localRuntime) {
      this.localRuntime.registerTool(tool, manifest);
      return;
    }
    return this.httpClient?.registerToolManifest(manifest);
  }

  run(input: RunInput): Promise<RunResult> {
    if (this.localRuntime) {
      return this.localRuntime.run(this.config, input);
    }
    if (!this.httpClient) {
      throw new Error("No runtime client is configured.");
    }
    return this.httpClient.run(input);
  }

  chat(input: RunInput): Promise<RunResult> {
    return this.run(input);
  }

  runStream(input: RunInput): AsyncGenerator<StreamEvent> {
    if (this.localRuntime) {
      return this.localRuntime.runStream(this.config, input);
    }
    if (!this.httpClient) {
      throw new Error("No runtime client is configured.");
    }
    return this.httpClient.runStream(input);
  }

  async chatStream(input: RunInput, onEvent: (event: StreamEvent) => void | Promise<void>): Promise<RunResult> {
    let final: RunResult | undefined;
    let output = "";
    let traceId = "";
    for await (const event of this.runStream(input)) {
      traceId = event.traceId;
      if (event.type === "token") {
        output += String(event.data ?? "");
      }
      if (event.type === "done") {
        const data = event.data as Partial<RunResult> | undefined;
        final = {
          traceId,
          output: String(data?.output ?? output),
          runtimeImageId: String(data?.runtimeImageId ?? ""),
          toolCalls: data?.toolCalls ?? [],
          reflection: String(data?.reflection ?? "")
        };
      }
      if (event.type === "error") {
        throw new Error(String(event.data ?? "Stream failed."));
      }
      await onEvent(event);
    }
    if (!final) {
      throw new Error("Stream finished without a final response.");
    }
    return final;
  }

  trackExperience(event: ExperienceEvent): Promise<ExperienceEvent> | ExperienceEvent {
    if (this.localRuntime) {
      return this.localRuntime.trackExperience(this.config, event);
    }
    return this.httpClient?.trackExperience(event) as Promise<ExperienceEvent>;
  }

  snapshot(snapshot: AppSnapshot): Promise<AppSnapshot> | AppSnapshot {
    if (this.localRuntime) {
      return this.localRuntime.snapshot(snapshot);
    }
    return this.httpClient?.snapshot(snapshot) as Promise<AppSnapshot>;
  }

  getActiveSuccessor() {
    return this.localRuntime?.store.activeImage() ?? this.httpClient?.getActiveSuccessor();
  }

  getPromotionHistory() {
    return this.localRuntime?.store.promotions ?? this.httpClient?.getPromotionHistory();
  }

  tickRecursion() {
    return this.localRuntime?.tick() ?? this.httpClient?.tickRecursion();
  }

  rollbackIfNeeded(recentScore: number) {
    return this.localRuntime?.rollbackIfNeeded(recentScore) ?? this.httpClient?.rollbackIfNeeded(recentScore);
  }

  sendUpdate(update: AppUpdatePackage) {
    if (this.localRuntime) {
      return this.localRuntime.deliverUpdate(this.config, update);
    }
    return this.httpClient?.sendUpdate(update);
  }

  exportTrainingData(options?: TrainingExportOptions) {
    if (this.localRuntime) {
      return this.localRuntime.exportTrainingData(options);
    }
    return this.httpClient?.exportTrainingData(options);
  }

  runRecursiveImprovementCycle() {
    if (this.localRuntime) {
      return this.localRuntime.runRecursiveImprovementCycle(this.config);
    }
    return this.httpClient?.runRecursiveImprovementCycle();
  }

  detectProfanity(text: string): boolean {
    return detectProfanity(text);
  }

  detectAnger(text: string): boolean {
    return detectAnger(text);
  }
}

const sharedLocalRuntimes = new Map<string, RecursiveRuntime>();

function getSharedLocalRuntime(appId: string): RecursiveRuntime {
  const existing = sharedLocalRuntimes.get(appId);
  if (existing) {
    return existing;
  }
  const runtime = new RecursiveRuntime();
  sharedLocalRuntimes.set(appId, runtime);
  return runtime;
}
