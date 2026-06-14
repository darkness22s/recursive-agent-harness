import { nanoid } from "nanoid";
import type { ExperienceEvent, ReflectionFinding } from "./types.js";

export function summarizeExperience(events: ExperienceEvent[]): ReflectionFinding[] {
  if (events.length === 0) {
    return [];
  }

  const angerEvents = events.filter((event) => event.sentimentSignals?.anger || event.sentimentSignals?.profanity);
  const abandoned = events.filter((event) => event.outcome === "abandoned" || event.outcome === "failed");
  const positive = events.filter((event) => event.outcome === "continued" || event.outcome === "converted");
  const findings: ReflectionFinding[] = [];

  if (angerEvents.length / events.length >= 0.2) {
    findings.push({
      id: nanoid(),
      severity: "high",
      theme: "anger recovery",
      evidence: angerEvents.slice(-5).map((event) => event.message),
      recommendation: "Make the next successor acknowledge anger sooner and switch to direct repair language."
    });
  }

  if (abandoned.length / events.length >= 0.25) {
    findings.push({
      id: nanoid(),
      severity: "high",
      theme: "abandonment",
      evidence: abandoned.slice(-5).map((event) => `${event.outcome}: ${event.message}`),
      recommendation: "Reduce loops, pick concrete next actions, and prefer tool execution when the user asks for progress."
    });
  }

  if (positive.length / events.length >= 0.6) {
    findings.push({
      id: nanoid(),
      severity: "low",
      theme: "retention-positive behavior",
      evidence: positive.slice(-5).map((event) => event.message),
      recommendation: "Preserve continuity and reflective tone while changing only failure recovery paths."
    });
  }

  return findings;
}

export function reflectionNarrative(findings: ReflectionFinding[]): string {
  if (findings.length === 0) {
    return "No strong retention pattern yet; keep the baseline reflective companion behavior.";
  }
  return findings.map((finding) => `${finding.theme}: ${finding.recommendation}`).join(" ");
}
