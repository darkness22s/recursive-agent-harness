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
  model?: {
    provider?: "ollama";
  };
  memory?: {
    kind: "file";
    directory: string;
    maxMessagesPerSession?: number;
  };
  search?: {
    enabled: boolean;
    provider?: "tinyfish";
    mode?: "freshness";
  };
  agentLoop?: {
    maxSteps?: number;
    maxToolCalls?: number;
    forceSearchOnFreshness?: boolean;
  };
  builtInTools?: {
    enabled?: boolean;
    workspaceRoot?: string;
    read?: boolean;
    write?: boolean;
    search?: boolean;
    command?: boolean;
    feedback?: boolean;
    allowedCommands?: string[];
    maxReadBytes?: number;
    commandTimeoutMs?: number;
  };
  updates?: {
    webhookUrl?: string;
    apiKey?: string;
    channel?: string;
  };
  agents?: {
    workerId?: string;
    researchCadenceMinutes?: number;
    autoQueueUpgrades?: boolean;
  };
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
  risk?: "low" | "medium" | "high";
  requiresApproval?: boolean;
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
  memory?: ConversationMessage[];
}

export interface StreamEvent {
  type: "start" | "agent_action" | "tool_call" | "token" | "done" | "error";
  traceId: string;
  data?: unknown;
}

export interface ToolCallResult {
  name: string;
  ok: boolean;
  input: unknown;
  output?: unknown;
  error?: string;
}

export interface ConversationMessage {
  id?: string;
  userId: string;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AppUpdatePackage {
  id?: string;
  appId?: string;
  channel?: string;
  version?: string;
  title: string;
  description: string;
  kind: "instruction" | "tool_manifest" | "ui_config" | "runtime_policy" | "bundle_url";
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface TrainingExportOptions {
  format?: "jsonl";
  path?: string;
  includeToolCalls?: boolean;
  includeExperience?: boolean;
}

export type RecursiveAgentRole = "researcher" | "upgrader";

export interface UpstreamAgentSource {
  id: "openai-agents-sdk" | "codex-cli" | "hermes-agent";
  name: string;
  sourceUrl: string;
  pinnedVersion: string;
  license: string;
  installed: boolean;
  notes: string[];
}

export interface ImprovementProposal {
  id?: string;
  createdAt?: string;
  researcherId: string;
  title: string;
  problem: string;
  evidence: string[];
  recommendedChange: string;
  expectedImpact: string;
  risk: "low" | "medium" | "high";
  updateKind: AppUpdatePackage["kind"];
  payload: Record<string, unknown>;
}

export interface UpgradePlan {
  id?: string;
  createdAt?: string;
  upgraderId: string;
  proposalId: string;
  status: "planned" | "queued" | "applied" | "rejected";
  summary: string;
  update?: AppUpdatePackage;
  taskId?: string;
  reasons: string[];
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
  | "memory"
  | "update"
  | "training_export"
  | "agent"
  | "research"
  | "upgrade"
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
