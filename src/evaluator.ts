import type { EvaluationReport, ExperienceEvent, RuntimeImage } from "./types.js";

export function evaluateSuccessor(active: RuntimeImage, candidate: RuntimeImage, events: ExperienceEvent[]): EvaluationReport {
  const enoughEvidence = events.length >= 3;
  const scoreDelta = candidate.score - active.score;
  const frustrationSpike = candidate.trainingWindow.angerRate > active.trainingWindow.angerRate + 0.35;
  const passed = enoughEvidence && scoreDelta >= 0.02 && !frustrationSpike;
  const reasons: string[] = [];

  if (!enoughEvidence) {
    reasons.push("Needs at least three experience events before autonomous promotion.");
  }
  if (scoreDelta >= 0.02) {
    reasons.push(`Candidate retention-quality score improved by ${scoreDelta.toFixed(3)}.`);
  } else {
    reasons.push(`Candidate score delta ${scoreDelta.toFixed(3)} is below promotion threshold.`);
  }
  if (frustrationSpike) {
    reasons.push("Candidate appears to amplify frustration beyond rollback tolerance.");
  }

  return {
    candidateId: candidate.id,
    activeId: active.id,
    score: candidate.score,
    activeScore: active.score,
    passed,
    reasons
  };
}
