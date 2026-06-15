import { nanoid } from "nanoid";
import type {
  ActivityRecord,
  AgentSummary,
  AppSnapshot,
  AppUpdatePackage,
  ConversationMessage,
  ExperienceEvent,
  ImprovementProposal,
  LocalTask,
  LocalWorkerRecord,
  PromotionRecord,
  RuntimeImage,
  StatusReport,
  StatusStats,
  ToolManifest
} from "./types.js";
import { defaultAngerTerms, defaultProfanityTerms } from "./detectors.js";

export class InMemoryHarnessStore {
  readonly events: ExperienceEvent[] = [];
  readonly snapshots: AppSnapshot[] = [];
  readonly tools = new Map<string, ToolManifest>();
  readonly images: RuntimeImage[] = [];
  readonly promotions: PromotionRecord[] = [];
  readonly activities: ActivityRecord[] = [];
  readonly summaries: AgentSummary[] = [];
  readonly localWorkers = new Map<string, LocalWorkerRecord>();
  readonly localTasks: LocalTask[] = [];
  readonly memories: ConversationMessage[] = [];
  readonly updates: AppUpdatePackage[] = [];
  readonly proposals: ImprovementProposal[] = [];

  constructor() {
    this.images.push({
      id: "runtime_1",
      createdAt: new Date().toISOString(),
      version: 1,
      artifact: {
        kind: "runtime-image",
        imageRef: "recursive-harness/runtime:1",
        checksum: "sha256:baseline"
      },
      behaviorPolicy: {
        tone: "reflective companion",
        recoveryStrategy: "acknowledge frustration, name the next concrete action, and keep continuity",
        toolRouting: "balanced",
        memoryPolicy: "remember recurring user preferences and anger triggers from host-provided traces"
      },
      telemetryDetectors: {
        profanityTerms: defaultProfanityTerms(),
        angerTerms: defaultAngerTerms()
      },
      evalAdditions: ["baseline angry-user recovery", "baseline tool failure recovery"],
      trainingWindow: {
        events: 0,
        angerRate: 0,
        abandonmentRate: 0,
        positiveRate: 0
      },
      score: 0.5,
      status: "active",
      rollbackThreshold: 0.08,
      promotionReason: "Initial runtime image"
    });
  }

  activeImage(): RuntimeImage {
    const active = this.images.find((image) => image.status === "active");
    if (!active) {
      throw new Error("No active runtime image is available.");
    }
    return active;
  }

  addEvent(event: ExperienceEvent): ExperienceEvent {
    const saved = {
      ...event,
      id: event.id ?? nanoid(),
      createdAt: event.createdAt ?? new Date().toISOString()
    };
    this.events.push(saved);
    this.addActivity({
      kind: "experience",
      title: `Experience ${saved.outcome}`,
      detail: saved.message,
      metadata: { userId: saved.userId, sessionId: saved.sessionId, sentimentSignals: saved.sentimentSignals }
    });
    return saved;
  }

  addSnapshot(snapshot: AppSnapshot): AppSnapshot {
    const saved = {
      ...snapshot,
      createdAt: snapshot.createdAt ?? new Date().toISOString()
    };
    this.snapshots.push(saved);
    return saved;
  }

  addMemory(message: ConversationMessage): ConversationMessage {
    const saved = {
      ...message,
      id: message.id ?? nanoid(),
      createdAt: message.createdAt ?? new Date().toISOString()
    };
    this.memories.push(saved);
    return saved;
  }

  addUpdate(update: AppUpdatePackage): AppUpdatePackage {
    const saved = {
      ...update,
      id: update.id ?? nanoid(),
      createdAt: update.createdAt ?? new Date().toISOString()
    };
    this.updates.push(saved);
    return saved;
  }

  addProposal(proposal: ImprovementProposal): ImprovementProposal {
    const saved = {
      ...proposal,
      id: proposal.id ?? nanoid(),
      createdAt: proposal.createdAt ?? new Date().toISOString()
    };
    this.proposals.push(saved);
    this.addActivity({
      kind: "research",
      title: saved.title,
      detail: saved.problem,
      metadata: { proposalId: saved.id, risk: saved.risk, expectedImpact: saved.expectedImpact }
    });
    return saved;
  }

  addTool(tool: ToolManifest): void {
    this.tools.set(tool.name, tool);
  }

  addImage(image: RuntimeImage): RuntimeImage {
    this.images.push(image);
    return image;
  }

  recordPromotion(record: PromotionRecord): PromotionRecord {
    this.promotions.push(record);
    this.addActivity({
      kind: record.action === "rolled_back" ? "rollback" : "promotion",
      title: `Runtime ${record.action}`,
      detail: `${record.previousImageId} -> ${record.nextImageId}`,
      scoreImpact: record.report.score - record.report.activeScore,
      metadata: { reasons: record.report.reasons }
    });
    return record;
  }

  addActivity(input: Omit<ActivityRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }): ActivityRecord {
    const activity: ActivityRecord = {
      id: input.id ?? nanoid(),
      createdAt: input.createdAt ?? new Date().toISOString(),
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      scoreImpact: input.scoreImpact,
      metadata: input.metadata
    };
    this.activities.push(activity);
    return activity;
  }

  addSummary(summary: Omit<AgentSummary, "id" | "createdAt">): AgentSummary {
    const saved: AgentSummary = {
      id: nanoid(),
      createdAt: new Date().toISOString(),
      ...summary
    };
    this.summaries.push(saved);
    this.addActivity({
      kind: "summary",
      title: "5-hour agent summary",
      detail: saved.message,
      metadata: { rangeHours: saved.rangeHours, stats: saved.stats }
    });
    return saved;
  }

  upsertLocalWorker(input: Omit<LocalWorkerRecord, "lastSeenAt" | "status">): LocalWorkerRecord {
    const worker: LocalWorkerRecord = {
      ...input,
      lastSeenAt: new Date().toISOString(),
      status: "online"
    };
    this.localWorkers.set(worker.id, worker);
    this.addActivity({
      kind: "local_worker",
      title: `${worker.name} heartbeat`,
      detail: `Local worker ${worker.id} is online`,
      metadata: { capabilities: worker.capabilities }
    });
    return worker;
  }

  enqueueLocalTask(input: Pick<LocalTask, "workerId" | "command" | "shell">): LocalTask {
    const now = new Date().toISOString();
    const task: LocalTask = {
      id: nanoid(),
      workerId: input.workerId,
      command: input.command,
      shell: input.shell,
      status: "queued",
      createdAt: now,
      updatedAt: now
    };
    this.localTasks.push(task);
    this.addActivity({
      kind: "local_task",
      title: "Local task queued",
      detail: `${input.shell}: ${input.command}`,
      metadata: { taskId: task.id, workerId: task.workerId }
    });
    return task;
  }

  nextLocalTask(workerId: string): LocalTask | undefined {
    const task = this.localTasks.find((candidate) => candidate.workerId === workerId && candidate.status === "queued");
    if (task) {
      task.status = "running";
      task.updatedAt = new Date().toISOString();
    }
    return task;
  }

  completeLocalTask(taskId: string, result: Pick<LocalTask, "status" | "output" | "error">): LocalTask {
    const task = this.localTasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    task.status = result.status;
    task.output = result.output;
    task.error = result.error;
    task.updatedAt = new Date().toISOString();
    this.addActivity({
      kind: "local_task",
      title: `Local task ${task.status}`,
      detail: task.error ?? task.output ?? task.command,
      metadata: { taskId: task.id, workerId: task.workerId }
    });
    return task;
  }

  statusReport(range: "24h" | "7d"): StatusReport {
    const since = Date.now() - (range === "24h" ? 24 : 24 * 7) * 60 * 60 * 1000;
    const inRange = (createdAt: string) => new Date(createdAt).getTime() >= since;
    const activities = this.activities.filter((activity) => inRange(activity.createdAt));
    const events = this.events.filter((event) => event.createdAt && inRange(event.createdAt));
    const summaries = this.summaries.filter((summary) => inRange(summary.createdAt));
    const workers = [...this.localWorkers.values()].map((worker) => ({
      ...worker,
      status: Date.now() - new Date(worker.lastSeenAt).getTime() < 2 * 60 * 1000 ? "online" as const : "stale" as const
    }));
    const tasks = this.localTasks.filter((task) => inRange(task.createdAt));
    const stats: StatusStats = {
      range,
      totalActivities: activities.length,
      runs: activities.filter((activity) => activity.kind === "run").length,
      experienceEvents: events.length,
      summaries: summaries.length,
      recursionTicks: activities.filter((activity) => activity.kind === "recursion").length,
      promotions: activities.filter((activity) => activity.kind === "promotion").length,
      rollbacks: activities.filter((activity) => activity.kind === "rollback").length,
      localWorkersOnline: workers.filter((worker) => worker.status === "online").length,
      localTasksQueued: tasks.filter((task) => task.status === "queued").length,
      localTasksCompleted: tasks.filter((task) => task.status === "succeeded").length,
      angerEvents: events.filter((event) => event.sentimentSignals?.anger || event.sentimentSignals?.profanity).length,
      abandonedEvents: events.filter((event) => event.outcome === "abandoned" || event.outcome === "failed").length
    };
    return {
      generatedAt: new Date().toISOString(),
      activeRuntimeImage: this.activeImage(),
      stats,
      recentActivities: activities.slice(-100).reverse(),
      summaries: summaries.slice(-20).reverse(),
      localWorkers: workers,
      localTasks: tasks.slice(-50).reverse()
    };
  }
}
