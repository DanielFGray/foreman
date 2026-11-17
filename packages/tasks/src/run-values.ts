/**
 * The words the `runs` and `defects` tables accept, which every writer validates
 * against. The tables' CHECK constraints are frozen in their migrations, so a
 * new value needs a migration too; run-values.test.ts fails until the stored
 * schema and these lists agree.
 */

/** The work an author's run can be. */
export const AUTHOR_WORK = ["build", "correction", "research"] as const;

/** The work an agent's run can be: an author's, or a reviewer's. */
export const AGENT_WORK = [...AUTHOR_WORK, "review"] as const;

/** Every value of `runs.work`. A check is written by the pipeline, never by an agent. */
export const WORK = [...AGENT_WORK, "check"] as const;

/** The registry's four words for how a closed run went. */
export const OUTCOMES = ["committed", "dropped", "handed-off", "answered"] as const;

/**
 * The defect kinds a review can record, each with what it means. The meaning
 * is what an operator reads in `--help` to choose a kind.
 */
export const DEFECTS = [
  { kind: "patch-around-wall", meaning: "flag, shim, fallback, second path" },
  { kind: "missed-caller", meaning: "a caller or copy left behind" },
  { kind: "duplication", meaning: "re-implemented something that exists" },
  { kind: "derivable-state", meaning: "stored or passed what could be computed" },
  { kind: "dead-code", meaning: "left code that nothing reaches" },
  { kind: "unverified-claim", meaning: "report claims something the evidence does not show" },
  { kind: "wrong-citation", meaning: "file:line or source that does not say that" },
  { kind: "scope-breach", meaning: "touched paths outside the slice" },
  { kind: "test-weakened", meaning: "test skipped, deleted or made vacuous" },
  { kind: "design-error", meaning: "wrong shape, not a local mistake" },
  { kind: "tool-misuse", meaning: "forbidden tool, untee'd tests, files left in the repo" },
  { kind: "comment-loss", meaning: "deleted a comment that stated why" },
  { kind: "stall", meaning: "stopped mid-task, quota, crash, lost track" },
] as const;

export const DEFECT_KINDS = DEFECTS.map((defect) => defect.kind);
