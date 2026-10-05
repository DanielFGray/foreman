import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { isResearch, type Item } from "./prog.ts";
import type { TaskPhase } from "./task-phase.ts";

/**
 * One slice of work as foreman saw it end, in the shape the model-trials
 * database keeps.
 *
 * The rows foreman can state are the ones it already derives: which model ran,
 * on which account, at what kind of work, and how the run ended. Two columns
 * stay null — `rounds`, which counts a review's correction rounds, and
 * `report_accurate`, which is a judgement about the author's report. Both are
 * the coordinator's to record; writing a number foreman cannot derive would put
 * a false fact in the table the operator chooses models from.
 *
 * The `defects` table is left alone for the same reason: a defect is a review
 * finding, and foreman reads findings as prose in a task log rather than as
 * typed kinds.
 */
export interface Trial {
  readonly project: string;
  readonly task: string;
  readonly slice: string;
  readonly kind: string;
  readonly pool: string;
  readonly model: string;
  readonly work: Work;
  readonly outcome: Outcome;
  readonly source: "live";
  readonly evidence: string;
  readonly notes: string;
}

export type Work = "build" | "research" | "review";
export type Outcome = "committed" | "dropped" | "handed-off" | "answered";

/**
 * The database's words for foreman's accounts.
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

/** The account's name as the trials table spells it, or the account itself. */
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
 * How a closed run ended, in the trials table's four words.
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
 * The phases that end a run, which is what a trial row describes.
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

/** Whether this phase ends a run and so has a trial to write. */
export const closes = (phase: TaskPhase): boolean => CLOSING.has(phase);

/**
 * One run's row, or nothing when the run has not ended.
 *
 * `undefined` is the honest answer for a live agent, and the caller writes
 * nothing rather than a row that says an unfinished thing was finished.
 */
export const trialFor = (input: {
  readonly task: Pick<Item, "id" | "title" | "project" | "labels">;
  readonly branch: string;
  readonly harness: string;
  readonly model: string | undefined;
  readonly provider: string | undefined;
  readonly role: "author" | "review";
  readonly phase: TaskPhase;
}): Trial | undefined => {
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
    work: workOf(input.role, research),
    outcome: outcomeOf(input.phase, research),
    source: "live",
    evidence: input.branch,
    notes: input.phase,
  };
};

/**
 * The trials database the herd skill keeps, at the one path it keeps it.
 *
 * The coordinator writes it by hand at every slice close, which is the manual
 * step this removes. It lives in the coordinator's home rather than foreman's
 * config because it is one file per machine that both tools already name; a
 * missing file is not an error, since a machine without the skill has nothing to
 * record into.
 */
const databasePath = (): string => `${process.env["HOME"] ?? ""}/.agents/model-trials.db`;

/**
 * Appends one row, if the file is there and has the columns we write.
 *
 * Nothing here can fail foreman. The database belongs to another tool, so a
 * missing file, a schema that has moved on, or a lock held by the coordinator is
 * a skipped row and never a stalled tick — and the columns are filtered against
 * what the table actually declares, so a trial row survives a schema that has
 * grown rather than throwing on a column it does not have.
 */
/**
 * An appender for one database file.
 *
 * The path is an argument rather than a hidden global so the only interesting
 * code here — a real insert into a schema foreman does not own — can be pointed
 * at a scratch file and proved, instead of being the one part of this module the
 * suite never runs.
 */
export const appendTo =
  (path: string) =>
  (trial: Trial): Effect.Effect<void> =>
    Effect.sync(() => {
      const db = new Database(path, { create: false, readwrite: true });
      try {
        const declared = db
          .query("PRAGMA table_info(trials)")
          .all()
          .map((row) => (row as { readonly name: string }).name);
        if (declared.length === 0) return;

        const wanted: Record<string, string | number | null> = {
          ...trial,
          closed_at: new Date().toISOString(),
          // The two judgements foreman cannot make, stated as absent rather than
          // guessed: the column is nullable precisely for a row written without them.
          rounds: null,
          report_accurate: null,
        };
        const columns = Object.keys(wanted).filter((name) => declared.includes(name));
        if (!columns.includes("task")) return;
        const values = columns.map((name) => wanted[name] ?? null);
        db.query(
          `INSERT INTO trials (${columns.join(", ")}) VALUES (${columns
            .map(() => "?")
            .join(", ")})`,
        ).run(...values);
      } finally {
        db.close();
      }
    }).pipe(
      // The cause, not the error: opening a file that is not there *throws*, which
      // makes it a defect, and `Effect.ignore` would let it through to take the
      // tick down. A skipped row is the promised outcome, so the defect is caught.
      Effect.catchAllDefect((defect) => Effect.logDebug(`trials row skipped: ${defect}`)),
    );

export class Trials extends Effect.Service<Trials>()("Trials", {
  effect: Effect.succeed({ record: appendTo(databasePath()) }),
}) {}
