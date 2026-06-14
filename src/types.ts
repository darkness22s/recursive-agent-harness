import type { z } from "zod";

export type OptimizationTarget = "retention";
export type AutonomyMode = "full";
export type Outcome = "continued" | "abandoned" | "escalated" | "converted" | "failed";

export interface HarnessConfig {
  appId: string;
  runtimeUrl: string | "local";
  apiKey: string;
  optimization: OptimizationTarget;
  autonomy: AutonomyMode;
}

export interface ToolContext {
  userId: string;
  sessionId: string;
  appId: string;
  traceId: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, context: ToolContext): Promise<TOutput> | TOutput;
}

export interface ToolManifest {
  name: string;
  description: string;
  schema: unknown;
}

export interface RunInput {
  userId: string;
  sessionId: string;
  input: string;
  context?: Record<string, unknown>;
}

export interface RunResult {
  traceId: string;
  output: string;
  runtimeImageId: string;
  toolCalls: ToolCallResult[];
  reflection: string;
}

export interface ToolCallResult {
  name: string;
  ok: boolean;
  input: unknown;
  output?: unknown;
  error?: string;
}

export interface ExperienceSignals {
  explicitRating?: number;
  profanity?: boolean;
  anger?: boolean;
  latencyMs?: number;
}

export interface ExperienceEvent {
  id?: string;
  appId?: string;
  userId: string;
  sessionId: string;
  message: string;
  response: string;
  sentimentSignals?: ExperienceSignals;
  outcome: Outcome;
  createdAt?: string;
}

export interface AppSnapshot {
  userId: string;
  sessionId: string;
  state: Record<string, unknown>;
  createdAt?: string;
}

export interface RuntimeImage {
  id: string;
  parentId?: string;
  createdAt: string;
  version: number;
  artifact: {
    kind: "runtime-image";
    imageRef: string;
    checksum: string;
  };
  behaviorPolicy: {
    tone: string;
    recoveryStrategy: string;
    toolRouting: "conservative" | "balanced" | "assertive";
    memoryPolicy: string;
  };
  telemetryDetectors: {
    profanityTerms: string[];
    angerTerms: string[];
  };
  evalAdditions: string[];
  trainingWindow: {
    events: number;
    angerRate: number;
    abandonmentRate: number;
    positiveRate: number;
  };
  score: number;
  status: "active" | "candidate" | "superseded" | "rolled_back";
  promotionReason?: string;
  rollbackThreshold: number;
}

export interface ReflectionFinding {
  id: string;
  severity: "low" | "medium" | "high";
  theme: string;
  evidence: string[];
  recommendation: string;
}

export interface EvaluationReport {
  candidateId: string;
  activeId: string;
  score: number;
  activeScore: number;
  passed: boolean;
  reasons: string[];
}

export interface PromotionRecord {
  id: string;
  previousImageId: string;
  nextImageId: string;
  createdAt: string;
  report: EvaluationReport;
  action: "promoted" | "rejected" | "rolled_back";
}

export type ActivityKind =
  | "run"
  | "experience"
  | "summary"
  | "recursion"
  | "promotion"
  | "rollback"
  | "search"
  | "local_worker"
  | "local_task";

export interface ActivityRecord {
  id: string;
  kind: ActivityKind;
  createdAt: string;
  title: string;
  detail: string;
  scoreImpact?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentSummary {
  id: string;
  createdAt: string;
  rangeHours: number;
  message: string;
  stats: StatusStats;
}

export interface LocalWorkerRecord {
  id: string;
  name: string;
  lastSeenAt: string;
  status: "online" | "stale";
  capabilities: string[];
}

export interface LocalTask {
  id: string;
  workerId: string;
  command: string;
  shell: "powershell" | "cmd" | "node" | "bash";
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  output?: string;
  error?: string;
}

export interface StatusStats {
  range: "24h" | "7d";
  totalActivities: number;
  runs: number;
  experienceEvents: number;
  summaries: number;
  recursionTicks: number;
  promotions: number;
  rollbacks: number;
  localWorkersOnline: number;
  localTasksQueued: number;
  localTasksCompleted: number;
  angerEvents: number;
  abandonedEvents: number;
}

export interface StatusReport {
  generatedAt: string;
  activeRuntimeImage: RuntimeImage;
  stats: StatusStats;
  recentActivities: ActivityRecord[];
  summaries: AgentSummary[];
  localWorkers: LocalWorkerRecord[];
  localTasks: LocalTask[];
}
