import { Schema } from "effect";
import type { WorkerState } from "./fleet.ts";
import type { TaskStatus } from "./prog.ts";

/** The observable situation that determines how settle must treat a task. */
export interface TaskPhaseInput {
  readonly status: TaskStatus;
  readonly reviewer: string | undefined;
  readonly worker: WorkerState;
  readonly worktree: boolean;
  readonly committed: boolean;
  readonly holdsWork: boolean;
  readonly handoffExpired: boolean;
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
  "Unfinished",
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
    if (!input.worktree) return "VanishedAttached";
    return input.committed || input.holdsWork ? "VanishedWithWork" : "VanishedEmpty";
  }

  if (input.worker === "blocked") return "Blocked";

  if (input.status === "reviewing") {
    if (input.reviewer === undefined) {
      return input.handoffExpired ? "ReviewExpired" : "ReviewWaiting";
    }
    return "ReviewStopped";
  }

  if (input.status !== "in_progress") return "Residue";
  return "Unfinished";
};
