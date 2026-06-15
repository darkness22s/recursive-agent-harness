import { nanoid } from "nanoid";
import { getOllamaModelConfig, isOllamaConfigured } from "./ollama.js";
import type {
  AppUpdatePackage,
  ExperienceEvent,
  HarnessConfig,
  ImprovementProposal,
  RecursiveAgentRole,
  ToolManifest,
  UpgradePlan,
  UpstreamAgentSource
} from "./types.js";

export const upstreamAgentSources: UpstreamAgentSource[] = [
  {
    id: "claude-agent-sdk",
    name: "Claude Agent SDK TypeScript",
    sourceUrl: "https://github.com/anthropics/claude-agent-sdk-typescript",
    pinnedVersion: "0.3.168",
    license: "MIT",
    installed: true,
    notes: [
      "Agent loop and context-management reference.",
      "Pinned to June 6, 2026 npm package under the 7-day safety rule."
    ]
  },
  {
    id: "codex-cli",
    name: "OpenAI Codex CLI",
    sourceUrl: "https://github.com/openai/codex",
    pinnedVersion: "0.137.0",
    license: "Apache-2.0",
    installed: true,
    notes: [
      "Terminal agent, sandbox, approval, and task orchestration reference.",
      "Pinned to June 4, 2026 npm package under the 7-day safety rule."
    ]
  },
  {
    id: "hermes-agent",
    name: "Hermes Agent",
    sourceUrl: "https://github.com/NousResearch/hermes-agent",
    pinnedVersion: "v2026.6.5",
    license: "MIT",
    installed: false,
    notes: [
      "Memory, skills, Kanban, and self-improvement-loop reference.",
      "Not installed as an npm package; source was only inspected from an older git tag because current repo results were marked today."
    ]
  }
];

export interface ResearchContext {
  config: HarnessConfig;
  events: ExperienceEvent[];
  tools: ToolManifest[];
  recentUpdates: AppUpdatePackage[];
}

export async function createResearchProposal(context: ResearchContext): Promise<ImprovementProposal> {
  const payload = await callAgentJson({
    role: "researcher",
    task:
      "Analyze user experience evidence and propose one concrete SDK/runtime improvement. Do not propose hard-coded user-response strings. Prefer configurable, testable behavior changes.",
    input: {
      appId: context.config.appId,
      optimization: context.config.optimization,
      experienceEvents: context.events.slice(-50),
      registeredTools: context.tools,
      recentUpdates: context.recentUpdates.slice(-10),
      upstreamSources: upstreamAgentSources
    }
  });

  return normalizeProposal(payload);
}

export async function createUpgradePlan(config: HarnessConfig, proposal: ImprovementProposal): Promise<UpgradePlan> {
  const payload = await callAgentJson({
    role: "upgrader",
    task:
      "Convert the research proposal into a structured host-app update package and an implementation plan. The researcher gives commands; the upgrader applies them only as structured update packages or queued VPS tasks.",
    input: {
      appId: config.appId,
      proposal,
      updateDeliveryConfigured: Boolean(config.updates?.webhookUrl),
      vpsWorkerId: config.agents?.workerId,
      upstreamSources: upstreamAgentSources
    }
  });

  return normalizeUpgradePlan(payload, proposal, config);
}

async function callAgentJson(input: { role: RecursiveAgentRole; task: string; input: unknown }): Promise<Record<string, unknown>> {
  const model = getOllamaModelConfig();
  if (!isOllamaConfigured(model)) {
    throw new Error("Ollama is not configured. Set OLLAMA_API_KEY before running recursive agents.");
  }

  const response = await fetch(`${model.host}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${model.apiKey}`
    },
    body: JSON.stringify({
      model: model.model,
      stream: false,
      options: {
        temperature: Number(process.env.RECURSIVE_HARNESS_AGENT_TEMPERATURE ?? 0.3)
      },
      messages: [
        {
          role: "system",
          content:
            "You are a private recursive SDK engineering agent. Return only valid JSON. Do not write prose outside JSON. Do not hard-code end-user replies. Do not expose private infrastructure to consumers. Use evidence, registered tools, and upstream architecture references to make configurable SDK/runtime improvements."
        },
        {
          role: "user",
          content: JSON.stringify(input)
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Recursive agent request failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { message?: { content?: string } };
  const content = body.message?.content?.trim();
  if (!content) {
    throw new Error("Recursive agent returned an empty response.");
  }
  return JSON.parse(extractJson(content)) as Record<string, unknown>;
}

function normalizeProposal(value: Record<string, unknown>): ImprovementProposal {
  return {
    id: String(value.id ?? nanoid()),
    createdAt: new Date().toISOString(),
    researcherId: String(value.researcherId ?? "researcher"),
    title: String(value.title ?? "Improve SDK behavior"),
    problem: String(value.problem ?? "User experience evidence indicates the SDK can improve."),
    evidence: arrayOfStrings(value.evidence),
    recommendedChange: String(value.recommendedChange ?? "Make the behavior configurable, observable, and test-covered."),
    expectedImpact: String(value.expectedImpact ?? "Better user experience and safer SDK updates."),
    risk: riskLevel(value.risk),
    updateKind: updateKind(value.updateKind),
    payload: objectPayload(value.payload)
  };
}

function normalizeUpgradePlan(value: Record<string, unknown>, proposal: ImprovementProposal, config: HarnessConfig): UpgradePlan {
  const update: AppUpdatePackage = {
    title: String(value.updateTitle ?? proposal.title),
    description: String(value.updateDescription ?? proposal.recommendedChange),
    kind: updateKind(value.updateKind ?? proposal.updateKind),
    channel: config.updates?.channel,
    payload: objectPayload(value.payload ?? proposal.payload)
  };
  return {
    id: String(value.id ?? nanoid()),
    createdAt: new Date().toISOString(),
    upgraderId: String(value.upgraderId ?? "upgrader"),
    proposalId: String(proposal.id),
    status: "planned",
    summary: String(value.summary ?? proposal.recommendedChange),
    update,
    reasons: arrayOfStrings(value.reasons)
  };
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    return fenced.trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end >= start ? text.slice(start, end + 1) : text;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function riskLevel(value: unknown): ImprovementProposal["risk"] {
  return value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function updateKind(value: unknown): AppUpdatePackage["kind"] {
  return value === "instruction" || value === "tool_manifest" || value === "ui_config" || value === "runtime_policy" || value === "bundle_url"
    ? value
    : "runtime_policy";
}
