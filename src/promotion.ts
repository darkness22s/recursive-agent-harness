import { nanoid } from "nanoid";
import type { EvaluationReport, PromotionRecord, RuntimeImage } from "./types.js";
import type { InMemoryHarnessStore } from "./store.js";

export function applyPromotion(store: InMemoryHarnessStore, candidate: RuntimeImage, report: EvaluationReport): PromotionRecord {
  const active = store.activeImage();
  const action = report.passed ? "promoted" : "rejected";

  if (report.passed) {
    active.status = "superseded";
    candidate.status = "active";
  }

  return store.recordPromotion({
    id: nanoid(),
    previousImageId: active.id,
    nextImageId: candidate.id,
    createdAt: new Date().toISOString(),
    report,
    action
  });
}

export function rollbackIfDegraded(store: InMemoryHarnessStore, recentScore: number): PromotionRecord | undefined {
  const active = store.activeImage();
  const previous = [...store.images].reverse().find((image) => image.id === active.parentId);
  if (!previous || recentScore >= active.score - active.rollbackThreshold) {
    return undefined;
  }

  active.status = "rolled_back";
  previous.status = "active";

  return store.recordPromotion({
    id: nanoid(),
    previousImageId: active.id,
    nextImageId: previous.id,
    createdAt: new Date().toISOString(),
    report: {
      candidateId: previous.id,
      activeId: active.id,
      score: previous.score,
      activeScore: recentScore,
      passed: true,
      reasons: [`Recent score ${recentScore.toFixed(3)} fell below rollback threshold.`]
    },
    action: "rolled_back"
  });
}
