import { nanoid } from "nanoid";
import type { ExperienceEvent, ReflectionFinding, RuntimeImage } from "./types.js";

function rate(events: ExperienceEvent[], predicate: (event: ExperienceEvent) => boolean): number {
  return events.length === 0 ? 0 : events.filter(predicate).length / events.length;
}

export function scoreEvents(events: ExperienceEvent[]): number {
  const angerRate = rate(events, (event) => Boolean(event.sentimentSignals?.anger || event.sentimentSignals?.profanity));
  const abandonmentRate = rate(events, (event) => event.outcome === "abandoned" || event.outcome === "failed");
  const positiveRate = rate(events, (event) => event.outcome === "continued" || event.outcome === "converted");
  return Math.max(0, Math.min(1, 0.5 + positiveRate * 0.35 - angerRate * 0.25 - abandonmentRate * 0.3));
}

export function buildSuccessorImage(active: RuntimeImage, events: ExperienceEvent[], findings: ReflectionFinding[]): RuntimeImage {
  const angerRate = rate(events, (event) => Boolean(event.sentimentSignals?.anger || event.sentimentSignals?.profanity));
  const abandonmentRate = rate(events, (event) => event.outcome === "abandoned" || event.outcome === "failed");
  const positiveRate = rate(events, (event) => event.outcome === "continued" || event.outcome === "converted");
  const severeFindings = findings.filter((finding) => finding.severity === "high");
  const scoreLift = severeFindings.length > 0 ? 0.09 : 0.03;

  return {
    id: `runtime_${nanoid(8)}`,
    parentId: active.id,
    createdAt: new Date().toISOString(),
    version: active.version + 1,
    artifact: {
      kind: "runtime-image",
      imageRef: `recursive-harness/runtime:${active.version + 1}`,
      checksum: `sha256:${nanoid(32)}`
    },
    behaviorPolicy: {
      tone: "reflective companion with decisive repair",
      recoveryStrategy:
        severeFindings.length > 0
          ? "mirror the user's frustration briefly, apologize for the bad experience, then take one concrete corrective action"
          : active.behaviorPolicy.recoveryStrategy,
      toolRouting: abandonmentRate > 0.2 ? "assertive" : active.behaviorPolicy.toolRouting,
      memoryPolicy: "promote recurring friction and recovery preferences into short-lived session memory before long-term memory"
    },
    telemetryDetectors: {
      profanityTerms: [...new Set([...active.telemetryDetectors.profanityTerms, "wtf", "fml"])],
      angerTerms: [...new Set([...active.telemetryDetectors.angerTerms, "annoyed", "waste of time", "not listening"])]
    },
    evalAdditions: [
      ...active.evalAdditions,
      ...findings.map((finding) => `regression: ${finding.theme}`)
    ],
    trainingWindow: {
      events: events.length,
      angerRate,
      abandonmentRate,
      positiveRate
    },
    score: Math.max(active.score, scoreEvents(events)) + scoreLift,
    status: "candidate",
    rollbackThreshold: active.rollbackThreshold,
    promotionReason: findings.length > 0 ? findings.map((finding) => finding.theme).join(", ") : "Incremental retention optimization"
  };
}
