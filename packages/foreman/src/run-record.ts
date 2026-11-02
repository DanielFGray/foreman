import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { reasonOf } from "./registry.ts";
import { countOf, isResearch, ROUNDS, SIZE, type Item } from "./prog.ts";
import type { TaskPhase } from "./task-phase.ts";

/**
 * One slice of work as foreman saw it end, in the shape of a closed row of the
 * task store's `runs` table.
 *
 * The rows foreman can state are the ones it already derives: which model ran,
 * on which account, at what kind of work, and how the run ended. `size` and
 * `rounds` come from the task's `size:<n>` and `rounds:<n>` labels, and are null
 * where the label is absent. `report_accurate` stays null: it is a judgement
 * about the author's report, and writing a value foreman cannot derive would
 * put a false fact in the table the operator chooses models from.
 *
 * The `defects` table is left alone for the same reason: a defect is a review
 * finding, and foreman reads findings as prose in a task log rather than as
 * typed kinds.
 */
export interface RunRecord {
  readonly project: string;
  readonly task: string;
  readonly slice: string;
  readonly kind: string;
  readonly pool: string;
  readonly model: string;
  /** The foreman rung that ran; null for a run launched by hand. */
  readonly rung: string | null;
  readonly work: Work;
  readonly outcome: Outcome;
  readonly source: "live";
  readonly evidence: string;
  readonly notes: string;
  readonly size: number | null;
  /** Correction rounds this author was sent; an author row only. */
  readonly rounds: number | null;
}

export type Work = "build" | "research" | "review";
export type Outcome = "committed" | "dropped" | "handed-off" | "answered";

/**
 * The store's words for foreman's accounts.
 *
 * A table rather than a convention, because the two sides were written by
 * different hands: foreman keys an account by what reads it (`opencode-go`),
 * the table names it as an operator reads it. An unlisted provider is written as
 * its own key, which is the honest answer rather than a wrong name.
 */
const POOLS: Record<string, string> = {
  openai: "OpenAI",
  "opencode-go": "OpenCode Go",
  opencode: "OpenCode Zen",
  claude: "Anthropic",
  anthropic: "Anthropic",
  copilot: "Copilot",
  cursor: "Cursor",
};

/** The account's name as the runs table spells it, or the account itself. */
export const poolFor = (provider: string): string => POOLS[provider] ?? provider;

/**
 * What kind of work the run was doing.
 *
 * `correction` is never written here: a correction is a second attempt on the
 * same slice, which the coordinator pairs by task rather than foreman seeing as
 * a separate event.
 */
const workOf = (role: "author" | "review", research: boolean): Work =>
  role === "review" ? "review" : research ? "research" : "build";

/**
 * How a closed run ended, in the runs table's four words.
 *
 * `ReviewReturned` is a hand-off and not a drop: the branch stays and the work
 * continues on a stronger rung, which is exactly what the table calls a
 * hand-off. Everything that stopped without a verdict is the same word, because
 * foreman cannot tell a crash from a timeout from an agent that lost track and
 * the table does not ask it to.
 */
const outcomeOf = (phase: TaskPhase, research: boolean): Outcome => {
  switch (phase) {
    case "Landed":
      return research ? "answered" : "committed";
    case "Canceled":
      return "dropped";
    default:
      return "handed-off";
  }
};

/**
 * The phases that end a run, which is what a run row describes.
 *
 * `Blocked`, `ReviewWaiting` and `ReviewExpired` are absent because the agent or
 * its reviewer is still there in all three: foreman closed a coach window, not a
 * run. Writing a row for those would end slices that have not ended.
 */
const CLOSING: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  "Landed",
  "Canceled",
  "ReviewReturned",
  "VanishedAttached",
  "VanishedWithWork",
  "VanishedEmpty",
  "ReviewStopped",
  "Residue",
  "Unfinished",
]);

/** Whether this phase ends a run and so has a run to write. */
export const closes = (phase: TaskPhase): boolean => CLOSING.has(phase);

/**
 * One run's row, or nothing when the run has not ended.
 *
 * `undefined` is the honest answer for a live agent, and the caller writes
 * nothing rather than a row that says an unfinished thing was finished.
 */
export const runFor = (input: {
  readonly task: Pick<Item, "id" | "title" | "project" | "labels">;
  readonly branch: string;
  readonly harness: string;
  readonly model: string | undefined;
  readonly rung?: string | undefined;
  readonly provider: string | undefined;
  readonly role: "author" | "review";
  readonly phase: TaskPhase;
  /** What the row says about the run when the phase alone does not, such as a usage wall. */
  readonly notes?: string | undefined;
}): RunRecord | undefined => {
  if (!closes(input.phase)) return undefined;
  const research = isResearch(input.task);
  return {
    project: input.task.project,
    task: input.task.id,
    // What the slice does, in words: the task's own title is the only sentence
    // foreman holds about it.
    slice: input.task.title,
    kind: input.harness,
    // An account foreman cannot name falls back to the harness, which is the same
    // row a rung with no model would have anyway.
    pool: input.provider === undefined ? input.harness : poolFor(input.provider),
    model: input.model ?? input.harness,
    rung: input.rung ?? null,
    work: workOf(input.role, research),
    outcome: outcomeOf(input.phase, research),
    source: "live",
    evidence: input.branch,
    notes: input.notes ?? input.phase,
    // `||`, not `??`: the table starts sizes at 1, so a `size:0` label reads as none.
    size: countOf(input.task, SIZE) || null,
    rounds: input.role === "author" ? (countOf(input.task, ROUNDS) ?? null) : null,
  };
};

/**
 * Inserts one closed run into the store's `runs` table, naming every column.
 *
 * `started_at` stays NULL (foreman does not keep starts), and so does
 * `report_accurate`: it is a judgement foreman cannot make, and the column is
 * nullable precisely for a row written without it. The insert fails when the
 * table is missing, and the failure carries the store's own message.
 */
export const insertRun = (run: RunRecord) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO runs
      (project, task, slice, kind, pool, model, rung, work, outcome, source, evidence, notes, size, rounds)
      VALUES (${run.project}, ${run.task}, ${run.slice}, ${run.kind}, ${run.pool}, ${run.model},
              ${run.rung}, ${run.work}, ${run.outcome}, ${run.source}, ${run.evidence},
              ${run.notes}, ${run.size}, ${run.rounds})`;
  });

/**
 * Records closed runs in the task store.
 *
 * A failed insert is logged at warning and never fails the tick: the store is
 * shared with other tools, so a lock they hold or a schema that moved on costs
 * a row, not a stalled fleet. The warning carries the cause, so a missing table
 * shows instead of vanishing.
 */
export class Runs extends Context.Service<Runs>()("Runs", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      record: (run: RunRecord): Effect.Effect<void> =>
        insertRun(run).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch((error) =>
            Effect.logWarning(`run row for ${run.task} not recorded: ${reasonOf(error)}`),
          ),
        ),
    };
  }),
}) {
  static readonly Default = Layer.effect(this, this.make);
}
