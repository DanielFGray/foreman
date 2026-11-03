import { Schema } from "effect";
import type { WorkerState } from "./fleet.ts";
import type { TaskStatus } from "./records.ts";

/** The observable situation that determines how settle must treat a task. */
export interface TaskPhaseInput {
  readonly status: TaskStatus;
  readonly reviewer: string | undefined;
  readonly worker: WorkerState;
  /**
   * The worker is an onboarding salvage in the operator's checkout, whose
   * tree is the operator's and is never committed or swept by foreman.
   */
  readonly attached: boolean;
  readonly committed: boolean;
  readonly holdsWork: boolean;
  readonly handoffExpired: boolean;
  /**
   * Placement puts the task past the author's running turn (at review, land
   * or done, or an author that named its exit). Replaces the old `reviewing`
   * status as the signal that the author has handed off.
   */
  readonly underReview: boolean;
}

/** One settled task's next handling, derived from the current world. */
export const TaskPhase = Schema.Literals([
  "Landed",
  "Canceled",
  "ReviewReturned",
  "VanishedAttached",
  "VanishedWithWork",
  "VanishedEmpty",
  "Blocked",
  "ReviewWaiting",
  "ReviewExpired",
  "ReviewStopped",
  "Residue",
  "AuthorStopped",
]);
export type TaskPhase = typeof TaskPhase.Type;

/** Classifies one non-working owned task before settle performs its effects. */
export const phaseOf = (input: TaskPhaseInput): TaskPhase => {
  if (input.status === "done") return "Landed";
  if (input.status === "canceled") return "Canceled";

  if (input.reviewer !== undefined && input.status === "open") {
    return "ReviewReturned";
  }

  if (input.worker === "gone") {
    if (input.attached) return "VanishedAttached";
    return input.committed || input.holdsWork ? "VanishedWithWork" : "VanishedEmpty";
  }

  if (input.worker === "blocked") return "Blocked";

  if (input.underReview) {
    if (input.reviewer === undefined) {
      return input.handoffExpired ? "ReviewExpired" : "ReviewWaiting";
    }
    return "ReviewStopped";
  }

  if (input.status !== "in_progress") return "Residue";
  return "AuthorStopped";
};
