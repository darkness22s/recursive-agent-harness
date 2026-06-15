import { nanoid } from "nanoid";
import type {
  AppSnapshot,
  AppUpdatePackage,
  ConversationMessage,
  EvaluationReport,
  ExperienceEvent,
  HarnessConfig,
  ImprovementProposal,
  PromotionRecord,
  RunInput,
  RunResult,
  StreamEvent,
  TrainingExportOptions,
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
import { generateOllamaAnswer, isOllamaConfigured, planAgentAction, streamOllamaAnswer, type AgentLoopAction } from "./ollama.js";
import { needsFreshSearch, searchTinyFish, type TinyFishSearchResult } from "./tinyfish.js";
import { createMemoryFromConfig } from "./memory.js";
import { deliverAppUpdate } from "./updates.js";
import { exportTrainingData } from "./training-export.js";
import { createResearchProposal, createUpgradePlan } from "./recursive-agents.js";

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
    const memory = createMemoryFromConfig(config);
    const memoryContext = await this.readMemoryContext(config, input);
    const userMemory = {
      userId: input.userId,
      sessionId: input.sessionId,
      role: "user",
      content: input.input,
      metadata: { context: input.context }
    } satisfies ConversationMessage;
    await memory?.append(userMemory);
    this.store.addMemory(userMemory);
    const toolCalls = await this.runAgentLoop(config, input, traceId, memoryContext);
    const searchResults = this.extractSearchResults(toolCalls);
    const findings = summarizeExperience(this.store.events);
    const reflection = reflectionNarrative(findings);
    const repairPrefix =
      detectAnger(input.input, image.telemetryDetectors.angerTerms) ||
      detectProfanity(input.input, image.telemetryDetectors.profanityTerms)
        ? "I hear the frustration. "
        : "";

    const modelOutput = isOllamaConfigured()
      ? await generateOllamaAnswer({
          run: input,
          toolCalls,
          searchResults,
          memory: memoryContext,
          reflection,
          recoveryStrategy: image.behaviorPolicy.recoveryStrategy,
          capabilities: this.privateCapabilities(config),
          updateDeliveryConfigured: Boolean(config.updates?.webhookUrl)
        })
      : this.missingModelError();
    const output = `${repairPrefix}${modelOutput}`;
    const assistantInput = {
      userId: input.userId,
      sessionId: input.sessionId,
      role: "assistant",
      content: output,
      metadata: { traceId, runtimeImageId: image.id, toolCalls }
    } satisfies ConversationMessage;
    const assistantMemory = await memory?.append(assistantInput);
    const storedAssistantMemory = this.store.addMemory(assistantMemory ?? assistantInput);
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
      reflection,
      memory: [...memoryContext, storedAssistantMemory]
    };
  }

  async *runStream(config: HarnessConfig, input: RunInput): AsyncGenerator<StreamEvent> {
    const traceId = nanoid();
    const image = this.store.activeImage();
    yield { type: "start", traceId };

    try {
      const memory = createMemoryFromConfig(config);
      const memoryContext = await this.readMemoryContext(config, input);
      const userMemory = {
        userId: input.userId,
        sessionId: input.sessionId,
        role: "user",
        content: input.input,
        metadata: { context: input.context }
      } satisfies ConversationMessage;
      await memory?.append(userMemory);
      this.store.addMemory(userMemory);

      const toolCalls: ToolCallResult[] = [];
      for await (const event of this.streamAgentLoop(config, input, traceId, memoryContext)) {
        if (event.type === "tool_call") {
          toolCalls.push(event.data as ToolCallResult);
        }
        yield event;
      }

      const findings = summarizeExperience(this.store.events);
      const reflection = reflectionNarrative(findings);
      const searchResults = this.extractSearchResults(toolCalls);
      let output = "";
      if (isOllamaConfigured()) {
        for await (const token of streamOllamaAnswer({
          run: input,
          toolCalls,
          searchResults,
          memory: memoryContext,
          reflection,
          recoveryStrategy: image.behaviorPolicy.recoveryStrategy,
          capabilities: this.privateCapabilities(config),
          updateDeliveryConfigured: Boolean(config.updates?.webhookUrl)
        })) {
          output += token;
          yield { type: "token", traceId, data: token };
        }
      } else {
        throw this.missingModelError();
      }

      if (!output) {
        throw new Error("Ollama returned an empty response.");
      }

      const assistantMemory = {
        userId: input.userId,
        sessionId: input.sessionId,
        role: "assistant",
        content: output,
        metadata: { traceId, runtimeImageId: image.id, toolCalls }
      } satisfies ConversationMessage;
      const savedAssistant = await memory?.append(assistantMemory);
      this.store.addMemory(savedAssistant ?? assistantMemory);
      this.store.addActivity({
        kind: "run",
        title: "Harness stream run",
        detail: input.input,
        metadata: { userId: input.userId, sessionId: input.sessionId, runtimeImageId: image.id, toolCalls }
      });
      yield { type: "done", traceId, data: { output, toolCalls } };
    } catch (error) {
      yield { type: "error", traceId, data: error instanceof Error ? error.message : String(error) };
    }
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

  remember(message: ConversationMessage): ConversationMessage {
    const saved = this.store.addMemory(message);
    this.store.addActivity({
      kind: "memory",
      title: "Conversation memory saved",
      detail: `${saved.role}: ${saved.content}`,
      metadata: { userId: saved.userId, sessionId: saved.sessionId }
    });
    return saved;
  }

  async deliverUpdate(config: HarnessConfig, update: AppUpdatePackage): Promise<AppUpdatePackage> {
    const delivered = await deliverAppUpdate(config, update);
    this.store.addUpdate(delivered);
    this.store.addActivity({
      kind: "update",
      title: "App update delivered",
      detail: delivered.title,
      metadata: { updateId: delivered.id, kind: delivered.kind, channel: delivered.channel }
    });
    return delivered;
  }

  async exportTrainingData(options?: TrainingExportOptions) {
    const result = await exportTrainingData({
      conversations: this.store.memories,
      experienceEvents: this.store.events,
      options
    });
    this.store.addActivity({
      kind: "training_export",
      title: "Training data exported",
      detail: `${result.count} training record(s) exported`,
      metadata: { path: result.path, format: result.format }
    });
    return result;
  }

  async runRecursiveImprovementCycle(config: HarnessConfig): Promise<{ proposal: ImprovementProposal; plan: Awaited<ReturnType<typeof createUpgradePlan>> }> {
    const proposal = this.store.addProposal(await createResearchProposal({
      config,
      events: this.store.events,
      tools: [...this.store.tools.values()],
      recentUpdates: this.store.updates
    }));
    const plan = await createUpgradePlan(config, proposal);
    let appliedPlan = plan;

    if (plan.update) {
      const update = await this.deliverUpdate(config, plan.update);
      appliedPlan = { ...appliedPlan, update, status: "applied" };
    }

    if (config.agents?.autoQueueUpgrades && config.agents.workerId) {
      const task = this.store.enqueueLocalTask({
        workerId: config.agents.workerId,
        shell: "bash",
        command: `printf '%s' '${escapeSingleQuotedJson({ proposal, plan: appliedPlan })}' > recursive-upgrade-${proposal.id}.json`
      });
      appliedPlan = { ...appliedPlan, taskId: task.id, status: "queued" };
    }

    this.store.addActivity({
      kind: "upgrade",
      title: appliedPlan.summary,
      detail: `Researcher proposal ${proposal.id} handled by upgrader ${appliedPlan.upgraderId}`,
      metadata: { proposalId: proposal.id, planId: appliedPlan.id, status: appliedPlan.status, taskId: appliedPlan.taskId }
    });

    return { proposal, plan: appliedPlan };
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

  private async runAgentLoop(config: HarnessConfig, input: RunInput, traceId: string, memoryContext: ConversationMessage[]): Promise<ToolCallResult[]> {
    const toolCalls: ToolCallResult[] = [];
    for (let step = 0; step < this.maxSteps(config); step += 1) {
      const action = await this.planNextAction(config, input, memoryContext, toolCalls);
      if (action.action === "answer") {
        break;
      }
      if (toolCalls.length >= this.maxToolCalls(config)) {
        toolCalls.push({ name: "agentLoop", ok: false, input: this.publicAction(action), error: "Agent loop tool-call limit reached." });
        break;
      }
      if (this.isRepeatedAction(toolCalls, action)) {
        toolCalls.push({ name: "agentLoop", ok: false, input: this.publicAction(action), error: "Agent loop stopped a repeated action." });
        break;
      }
      const call = await this.executeAgentAction(config, input, traceId, action);
      toolCalls.push(call);
      if (!call.ok) {
        break;
      }
    }
    return toolCalls;
  }

  private async *streamAgentLoop(config: HarnessConfig, input: RunInput, traceId: string, memoryContext: ConversationMessage[]): AsyncGenerator<StreamEvent> {
    const toolCalls: ToolCallResult[] = [];
    for (let step = 0; step < this.maxSteps(config); step += 1) {
      const action = await this.planNextAction(config, input, memoryContext, toolCalls);
      yield { type: "agent_action", traceId, data: this.publicAction(action) };
      if (action.action === "answer") {
        break;
      }
      if (toolCalls.length >= this.maxToolCalls(config)) {
        const call = { name: "agentLoop", ok: false, input: this.publicAction(action), error: "Agent loop tool-call limit reached." };
        toolCalls.push(call);
        yield { type: "tool_call", traceId, data: call };
        break;
      }
      if (this.isRepeatedAction(toolCalls, action)) {
        const call = { name: "agentLoop", ok: false, input: this.publicAction(action), error: "Agent loop stopped a repeated action." };
        toolCalls.push(call);
        yield { type: "tool_call", traceId, data: call };
        break;
      }
      const call = await this.executeAgentAction(config, input, traceId, action);
      toolCalls.push(call);
      yield { type: "tool_call", traceId, data: call };
      if (!call.ok) {
        break;
      }
    }
  }

  private async planNextAction(config: HarnessConfig, input: RunInput, memoryContext: ConversationMessage[], toolCalls: ToolCallResult[]): Promise<AgentLoopAction> {
    const heuristicSearch =
      (config.agentLoop?.forceSearchOnFreshness ?? true) &&
      config.search?.enabled &&
      toolCalls.length === 0 &&
      needsFreshSearch(input.input);
    if (heuristicSearch) {
      return { action: "search", query: input.input, reason: "current-data request" };
    }
    if (!config.search?.enabled && this.tools.size === 0) {
      return { action: "answer" };
    }
    return planAgentAction({
      run: input,
      memory: memoryContext,
      tools: [...this.store.tools.values()],
      toolCalls,
      capabilities: this.privateCapabilities(config),
      searchEnabled: Boolean(config.search?.enabled)
    });
  }

  private async executeAgentAction(config: HarnessConfig, input: RunInput, traceId: string, action: AgentLoopAction): Promise<ToolCallResult> {
    if (action.action === "search") {
      return this.callSearch(config, input, traceId, action.query);
    }
    if (action.action === "tool") {
      return this.callHostTool(config, input, traceId, action);
    }
    return { name: "agentAnswer", ok: true, input: {}, output: action.answer ?? "" };
  }

  private async callHostTool(config: HarnessConfig, input: RunInput, traceId: string, action: Extract<AgentLoopAction, { action: "tool" }>): Promise<ToolCallResult> {
    const selected = this.tools.get(action.toolName);
    const candidateInput = action.input ?? {};
    if (!selected) {
      return { name: action.toolName, ok: false, input: candidateInput, error: "Requested tool is not registered." };
    }
    if (selected.requiresApproval || selected.risk === "high") {
      return {
        name: selected.name,
        ok: false,
        input: candidateInput,
        error: "Tool requires host approval before execution."
      };
    }

    try {
      const parsed = selected.inputSchema.safeParse(candidateInput);
      if (!parsed.success) {
        return { name: selected.name, ok: false, input: candidateInput, error: parsed.error.message };
      }
      const output = await selected.execute(parsed.data, {
        userId: input.userId,
        sessionId: input.sessionId,
        appId: config.appId,
        traceId
      });
      return { name: selected.name, ok: true, input: parsed.data, output };
    } catch (error) {
      return { name: selected.name, ok: false, input: candidateInput, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async callSearch(config: HarnessConfig, input: RunInput, traceId: string, query: string): Promise<ToolCallResult> {
    if (!config.search?.enabled) {
      return { name: "tinyfishSearch", ok: false, input: { query }, error: "Search is not enabled for this app." };
    }
    const toolInput = { query };
    try {
      const output = await searchTinyFish(query);
      this.store.addActivity({
        kind: "search",
        title: "TinyFish search",
        detail: query,
        metadata: {
          userId: input.userId,
          sessionId: input.sessionId,
          appId: config.appId,
          traceId,
          resultCount: output.results.length
        }
      });
      return { name: "tinyfishSearch", ok: true, input: toolInput, output };
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
          query
        }
      });
      return { name: "tinyfishSearch", ok: false, input: toolInput, error: message };
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

  private missingModelError(): never {
    throw new Error("Ollama is not configured. Set OLLAMA_API_KEY before calling chat(), run(), or runStream().");
  }

  private publicAction(action: AgentLoopAction): Record<string, unknown> {
    if (action.action === "search") {
      return { action: "search", query: action.query };
    }
    if (action.action === "tool") {
      return { action: "tool", toolName: action.toolName };
    }
    return { action: "answer" };
  }

  private maxSteps(config: HarnessConfig): number {
    return clampInteger(config.agentLoop?.maxSteps ?? 6, 1, 12);
  }

  private maxToolCalls(config: HarnessConfig): number {
    return clampInteger(config.agentLoop?.maxToolCalls ?? 4, 0, 10);
  }

  private isRepeatedAction(toolCalls: ToolCallResult[], action: AgentLoopAction): boolean {
    if (action.action === "answer") {
      return false;
    }
    const name = action.action === "search" ? "tinyfishSearch" : action.toolName;
    const input = action.action === "search" ? { query: action.query } : action.input ?? {};
    const serialized = stableStringify(input);
    return toolCalls.some((call) => call.name === name && stableStringify(call.input) === serialized);
  }

  private async readMemoryContext(config: HarnessConfig, input: RunInput): Promise<ConversationMessage[]> {
    const limit = config.memory?.maxMessagesPerSession ?? 40;
    const fileMemory = createMemoryFromConfig(config);
    if (fileMemory) {
      return fileMemory.read({ userId: input.userId, sessionId: input.sessionId, limit });
    }
    return this.store.memories
      .filter((message) => message.userId === input.userId && message.sessionId === input.sessionId)
      .slice(-limit);
  }

  private privateCapabilities(config: HarnessConfig): string[] {
    return [
      "normal conversation",
      config.memory ? "file-backed memory" : undefined,
      config.search?.enabled ? "current-data search" : undefined,
      this.tools.size > 0 ? "host-registered tools" : undefined,
      config.updates?.webhookUrl ? "host app update delivery" : undefined,
      "experience tracking",
      "successor evaluation",
      "training data export"
    ].filter(Boolean) as string[];
  }
}

function escapeSingleQuotedJson(value: unknown): string {
  return JSON.stringify(value).replace(/'/g, "'\\''");
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
