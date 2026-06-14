import { nanoid } from "nanoid";
import type {
  AppSnapshot,
  EvaluationReport,
  ExperienceEvent,
  HarnessConfig,
  PromotionRecord,
  RunInput,
  RunResult,
  ToolCallResult,
  ToolDefinition,
  ToolManifest
} from "./types.js";
import { InMemoryHarnessStore } from "./store.js";
import { detectAnger, detectProfanity } from "./detectors.js";
import { reflectionNarrative, summarizeExperience } from "./reflection.js";
import { buildSuccessorImage } from "./successor.js";
import { evaluateSuccessor } from "./evaluator.js";
import { applyPromotion, rollbackIfDegraded } from "./promotion.js";
import { generateOllamaAnswer } from "./ollama.js";
import { needsFreshSearch, searchTinyFish, type TinyFishSearchResult } from "./tinyfish.js";

export interface RuntimeTickResult {
  candidateId: string;
  report: EvaluationReport;
  promotion: PromotionRecord;
}

export class RecursiveRuntime {
  readonly store: InMemoryHarnessStore;
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(store = new InMemoryHarnessStore()) {
    this.store = store;
  }

  registerTool(tool: ToolDefinition, manifest?: ToolManifest): void {
    this.tools.set(tool.name, tool);
    this.store.addTool(
      manifest ?? {
        name: tool.name,
        description: tool.description,
        schema: "zod-schema"
      }
    );
  }

  registerToolManifest(manifest: ToolManifest): void {
    this.store.addTool(manifest);
  }

  async run(config: HarnessConfig, input: RunInput): Promise<RunResult> {
    const traceId = nanoid();
    const image = this.store.activeImage();
    const toolCalls = [
      ...(await this.maybeSearch(config, input, traceId)),
      ...(await this.maybeCallTools(config, input, traceId))
    ];
    const searchResults = this.extractSearchResults(toolCalls);
    const findings = summarizeExperience(this.store.events);
    const reflection = reflectionNarrative(findings);
    const repairPrefix =
      detectAnger(input.input, image.telemetryDetectors.angerTerms) ||
      detectProfanity(input.input, image.telemetryDetectors.profanityTerms)
        ? "I hear the frustration. "
        : "";

    const modelOutput = await generateOllamaAnswer({
      run: input,
      toolCalls,
      searchResults,
      reflection,
      recoveryStrategy: image.behaviorPolicy.recoveryStrategy
    });
    const output = `${repairPrefix}${modelOutput ?? this.composeAnswer(input, toolCalls, image.behaviorPolicy.recoveryStrategy)}`;
    this.store.addActivity({
      kind: "run",
      title: "Harness run",
      detail: input.input,
      metadata: { userId: input.userId, sessionId: input.sessionId, runtimeImageId: image.id, toolCalls }
    });

    return {
      traceId,
      output,
      runtimeImageId: image.id,
      toolCalls,
      reflection
    };
  }

  trackExperience(config: HarnessConfig, event: ExperienceEvent): ExperienceEvent {
    const enriched = {
      ...event,
      appId: event.appId ?? config.appId,
      sentimentSignals: {
        profanity: detectProfanity(event.message),
        anger: detectAnger(event.message),
        ...event.sentimentSignals
      }
    };
    return this.store.addEvent(enriched);
  }

  snapshot(snapshot: AppSnapshot): AppSnapshot {
    return this.store.addSnapshot(snapshot);
  }

  tick(): RuntimeTickResult {
    const active = this.store.activeImage();
    const findings = summarizeExperience(this.store.events);
    const candidate = this.store.addImage(buildSuccessorImage(active, this.store.events, findings));
    const report = evaluateSuccessor(active, candidate, this.store.events);
    const promotion = applyPromotion(this.store, candidate, report);
    this.store.addActivity({
      kind: "recursion",
      title: "Recursive successor tick",
      detail: report.reasons.join(" "),
      scoreImpact: report.score - report.activeScore,
      metadata: { candidateId: candidate.id, activeId: active.id, promoted: report.passed }
    });
    return {
      candidateId: candidate.id,
      report,
      promotion
    };
  }

  rollbackIfNeeded(recentScore: number): PromotionRecord | undefined {
    return rollbackIfDegraded(this.store, recentScore);
  }

  createFiveHourSummary() {
    const report = this.store.statusReport("24h");
    const stats = report.stats;
    const message = [
      "I am still running and will not stop by design.",
      `In the last 24h I saw ${stats.totalActivities} activities, ${stats.runs} runs, ${stats.experienceEvents} experience events, ${stats.recursionTicks} recursion ticks, ${stats.promotions} promotions, and ${stats.rollbacks} rollbacks.`,
      `${stats.localWorkersOnline} local worker(s) are online. ${stats.angerEvents} anger signal(s) and ${stats.abandonedEvents} abandoned/failed event(s) were detected.`
    ].join(" ");
    return this.store.addSummary({
      rangeHours: 5,
      message,
      stats
    });
  }

  private async maybeCallTools(config: HarnessConfig, input: RunInput, traceId: string): Promise<ToolCallResult[]> {
    const lower = input.input.toLowerCase();
    const selected = [...this.tools.values()].find((tool) => lower.includes(tool.name.toLowerCase()));
    if (!selected) {
      return [];
    }

    try {
      const candidateInput = this.deriveToolInput(input.input, selected.name);
      const parsed = selected.inputSchema.safeParse(candidateInput);
      if (!parsed.success) {
        return [{ name: selected.name, ok: false, input: candidateInput, error: parsed.error.message }];
      }
      const output = await selected.execute(parsed.data, {
        userId: input.userId,
        sessionId: input.sessionId,
        appId: config.appId,
        traceId
      });
      return [{ name: selected.name, ok: true, input: parsed.data, output }];
    } catch (error) {
      return [{ name: selected.name, ok: false, input: {}, error: error instanceof Error ? error.message : String(error) }];
    }
  }

  private async maybeSearch(config: HarnessConfig, input: RunInput, traceId: string): Promise<ToolCallResult[]> {
    if (!needsFreshSearch(input.input)) {
      return [];
    }

    const toolInput = { query: input.input };
    try {
      const output = await searchTinyFish(input.input);
      this.store.addActivity({
        kind: "search",
        title: "TinyFish search",
        detail: input.input,
        metadata: {
          userId: input.userId,
          sessionId: input.sessionId,
          appId: config.appId,
          traceId,
          resultCount: output.results.length
        }
      });
      return [{ name: "tinyfishSearch", ok: true, input: toolInput, output }];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.addActivity({
        kind: "search",
        title: "TinyFish search failed",
        detail: message,
        metadata: {
          userId: input.userId,
          sessionId: input.sessionId,
          appId: config.appId,
          traceId,
          query: input.input
        }
      });
      return [{ name: "tinyfishSearch", ok: false, input: toolInput, error: message }];
    }
  }

  private extractSearchResults(toolCalls: ToolCallResult[]): TinyFishSearchResult[] {
    return toolCalls.flatMap((call) => {
      if (call.name !== "tinyfishSearch" || !call.ok) {
        return [];
      }
      const output = call.output as { results?: TinyFishSearchResult[] } | undefined;
      return Array.isArray(output?.results) ? output.results : [];
    });
  }

  private deriveToolInput(text: string, toolName: string): Record<string, unknown> {
    const quoted = text.match(/["']([^"']+)["']/)?.[1];
    const called = text.match(new RegExp(`${toolName}\\s+([\\w -]+)`, "i"))?.[1]?.trim();
    return {
      name: quoted ?? called ?? "untitled"
    };
  }

  private composeAnswer(input: RunInput, toolCalls: ToolCallResult[], recoveryStrategy: string): string {
    if (toolCalls.length > 0) {
      const call = toolCalls[0];
      return call.ok
        ? `Done. I used ${call.name} and kept the session moving.`
        : `I tried ${call.name}, but it failed: ${call.error}. ${recoveryStrategy}.`;
    }
    return `I am using the active recursive harness to respond and preserve continuity for session ${input.sessionId}.`;
  }
}
