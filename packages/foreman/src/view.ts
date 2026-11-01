import { Match } from "effect";
import type {
  Active,
  Ask,
  Climbing,
  FleetState,
  Held,
  Provider,
  StaleRow,
  Unreviewed,
} from "./dispatcher.ts";
import { exhausted, type Allowance } from "./quota.ts";
import { resetsLabel, usedLabel } from "./format.ts";
import type { Worker } from "./fleet.ts";
import {
  diagnosticIntent,
  failuresOf,
  needsYou,
  reviewedBy,
  type EpicProgress,
  type Item,
} from "./prog.ts";

/**
 * The dashboard as data: every line, every legal action, no renderer.
 *
 * The screen this feeds is a list of rows with a preview each, so everything
 * here is a total function from the dispatcher's last reading to strings. That
 * is the whole reason the module exists apart from the driver: the rules about
 * which key reaches which row are the part worth testing, and none of them
 * need a terminal to answer.
 */

const COLUMNS = [
  "queue",
  "working",
  "review",
  "landed",
  "decisions",
  "asks",
  "yours",
  "held",
  "unreviewed",
  "stale",
  "orphans",
  "quota",
] as const;
export type ColumnName = (typeof COLUMNS)[number];

export const VIEWS = ["queue", "working", "review", "landed", "quota", "attention"] as const;
export type ViewName = (typeof VIEWS)[number];

export type DecisionKind =
  | "author vanished"
  | "reviewer vanished"
  | "orphaned workspace"
  | "dispatch failed";

/**
 * Which kind of decision a row is, from the task's status.
 *
 * Status decides, not labels. A workspace left behind by a failed spawn still
 * carries its by-* label while its task sits back in the queue, so naming from
 * the labels alone would call it an author that vanished; the task's status —
 * neither claimed nor under review — is what makes it residue. A dispatch
 * failure is the one kind status cannot name: the task is ordinary queue work,
 * so the failure itself is what marks the row.
 */
export const decisionKind = (task: Item, failure: string | undefined = undefined): DecisionKind =>
  failure !== undefined
    ? "dispatch failed"
    : task.status === "reviewing"
      ? "reviewer vanished"
      : task.status === "in_progress"
        ? "author vanished"
        : "orphaned workspace";

/**
 * Whether a review-by:* label has no live reviewer behind it, so it is stale.
 *
 * The world records whether a reviewer was dispatched, not whether that
 * reviewer is still alive. A task that is open — waiting in the queue — with a
 * review-by:* label is stale by definition, because a real review keeps the
 * task in `reviewing` with its reviewer beside it; the label only survives on
 * an open task when the review is already over. A workspace that is gone, or a
 * reviewer that settled, is nobody behind the label. Only the operator can say
 * the label is stale, and this is the only place that asks.
 */
export const staleReview = (
  task: { readonly labels: ReadonlyArray<string>; readonly status?: string },
  worker: Worker | undefined,
): boolean =>
  reviewedBy(task) !== undefined &&
  (task.status === undefined || task.status === "open") &&
  (worker === undefined || worker.state === "gone" || worker.state === "settled");

/** One selectable line in any column, with the targets its actions need. */
export interface ColumnRow {
  readonly column: ColumnName;
  readonly key: string;
  readonly label: string;

  /**
   * The second line of the row, where a name alone does not answer the
   * question the row raises.
   *
   * The exceptional states all have one: which agent went away, what is
   * holding a project, what a dispatch failed on. Packing that onto the name's
   * line is what made the reason the half a narrow pane truncated away.
   */
  readonly detail: string | undefined;
  /** The full task, for rows that came out of a claimed status. */
  readonly task: Item | undefined;
  /** The queued task, which has never been claimed and so never has a status. */
  readonly ready: Item | undefined;
  readonly worker: Worker | undefined;
  readonly project: string | undefined;
  /** The hold's reason, for rows whose actions depend on what is holding it. */
  readonly reason: Held["reason"] | undefined;
  /** The branch behind an unreviewed row, whose commits nothing is reading. */
  readonly unreviewed: Unreviewed | undefined;
  /** The overtaken branch behind a stale row, whose review could not land. */
  readonly stale: StaleRow | undefined;
  /** The step an asks row is waiting for approval; see `Ask`. */
  readonly ask: Ask | undefined;
  /** The account behind a quota row, whose every window the preview reads. */
  readonly provider: Provider | undefined;
  /** The error behind a dispatch-failed decision row. */
  readonly failure: string | undefined;
  readonly hasWork: boolean;
  readonly committed: boolean;
}

export const ACTIONS_LIST = [
  "complete",
  "retry",
  "release",
  "close",
  "takeOver",
  "focus",
  "kill",
  "intervene",
  "descend",
  "unassign",
  "onboard",
  "adopt",
  "approve",
] as const;

/** Something an operator does to one row. */
export type Action = (typeof ACTIONS_LIST)[number];

/**
 * Which keys mean something in which column.
 *
 * Landed is history and takes no action; a queue task can only climb, because
 * releasing a task that was never claimed has nothing to undo. The same key
 * does not change meaning between columns.
 *
 * The two corrections — `descend` and `unassign` — are offered wherever their
 * labels could have been written, and a row without the label ignores the key
 * rather than doing nothing to a claim. `descend` only reaches a row carrying
 * a `needs-you` label or a recorded failure: with nothing written against the
 * task there is nothing to take back. `unassign` only reaches a row whose
 * review-by:* label has no live reviewer behind it.
 *
 * `yours` takes no answer key, and that is the design rather than an omission.
 * A task waits there because a question about it is unanswered, and a single
 * key to put it back would hand the next agent the same unanswered question —
 * the exact failure the column exists to prevent. It leaves when the operator
 * writes the decision into the task and removes its `needs-you` label, in
 * that order, with prog. The two corrections do reach it: a task parked at the
 * operator is exactly the sort of judgement that can turn out to have been
 * written without being earned, and no other column shows a `needs-you` task
 * to take it back from.
 */
const ACTIONS: Record<ColumnName, ReadonlyArray<Action>> = {
  queue: ["complete", "intervene", "descend", "unassign"],
  working: ["focus", "kill", "intervene", "descend", "release"],
  review: ["focus", "kill", "intervene", "descend", "release"],
  landed: [],
  decisions: ["retry", "takeOver", "intervene", "release", "close", "unassign"],
  // Approval is the only answer an ask takes. Release and kill stay on the
  // column the work is in, where they already apply.
  asks: ["approve"],
  yours: ["intervene", "descend", "unassign"],
  held: ["onboard"],
  unreviewed: ["adopt"],
  stale: ["intervene", "descend", "release"],
  // No task remains to retry, release, or lower — the store has forgotten it.
  // Closing the workspace is the only thing left that is true.
  orphans: ["close"],
  // The quota view is a reading, not a set of commands: an account that is
  // spent is spent until it resets, and the way past it is to move a task to a
  // rung on another account — which is a key on that task, in the queue, not
  // on the row naming the account.
  quota: [],
};

/**
 * Which decisions allow which answers, because the answers differ.
 *
 * A vanished author or reviewer can be retried, taken over, or released. An
 * orphaned workspace has no claim to undo — releasing would reopen a done or
 * canceled task — so it is only ever closed, or, when it carries a review-by:*
 * label no reviewer is behind, unassigned.
 */
const DECISION_ACTIONS: Record<DecisionKind, ReadonlyArray<Action>> = {
  "author vanished": ["retry", "takeOver", "intervene", "release"],
  "reviewer vanished": ["retry", "takeOver", "intervene", "release"],
  "orphaned workspace": ["intervene", "close", "unassign"],
  // Nothing to take over or release: the agent never started. The one answer
  // is to clear the cause and retry.
  "dispatch failed": ["retry"],
};

/** The commands that are meaningful for this exact row, not just its column. */
export const actionsFor = (
  column: ColumnName,
  row: ColumnRow | undefined,
): ReadonlyArray<Action> => {
  if (!row) return [];
  // An epic has no branch and no worker, so every action is meaningless on it.
  if (row.task?.type === "epic") return [];
  const actions =
    column === "decisions" && row.task
      ? DECISION_ACTIONS[decisionKind(row.task, row.failure)]
      : ACTIONS[column];

  return actions.filter((action) =>
    Match.value(action).pipe(
      Match.when("takeOver", () => row.worker !== undefined),
      Match.when("focus", () => row.worker !== undefined),
      Match.when(
        "kill",
        () =>
          row.worker !== undefined &&
          (row.worker.state === "working" || row.worker.state === "blocked"),
      ),
      // There is something to take back where a rung was failed, and where a
      // person parked the task above the ladder entirely.
      Match.when("descend", () => {
        const item = row.task ?? row.ready;
        return item !== undefined && (needsYou(item) || failuresOf(item).length > 0);
      }),
      Match.when(
        "unassign",
        () =>
          (row.task !== undefined && staleReview(row.task, row.worker)) ||
          (row.ready !== undefined && staleReview(row.ready, undefined)),
      ),
      Match.when("retry", () => row.task !== undefined),
      Match.when("release", () => row.task !== undefined),
      // Closing takes down a workspace, so the workspace is what it needs —
      // an orphan's task has been deleted out of the store and there is none.
      Match.when("close", () => row.worker !== undefined),
      Match.when("complete", () => row.ready !== undefined),
      Match.when(
        "intervene",
        () =>
          row.ready !== undefined ||
          (row.task !== undefined && row.task.status !== "done" && row.task.status !== "canceled"),
      ),
      Match.when("onboard", () => row.project !== undefined && row.reason === "dirty"),
      Match.when("adopt", () => row.unreviewed !== undefined),
      Match.when("approve", () => row.ask !== undefined),
      Match.exhaustive,
    ),
  );
};

/** The task a row's corrections and interventions act on, whichever half holds it. */
export const climbing = (row: ColumnRow): Climbing | undefined => row.task ?? row.ready;

const rowsFor = (column: ColumnName, state: FleetState): ReadonlyArray<ColumnRow> =>
  Match.value(column).pipe(
    Match.when("queue", () => state.queue.map(queueRow)),
    Match.when("working", () => state.working.map((active) => activeRow(active, "working", state))),
    Match.when("review", () => state.review.map((active) => activeRow(active, "review", state))),
    Match.when("landed", () => state.landed.map((task) => landedRow(task, state))),
    Match.when("decisions", () => state.decisions.map((active) => decisionRow(active, state))),
    Match.when("asks", () => state.asks.map(askRow)),
    Match.when("yours", () => state.yours.map((task) => yoursRow(task, state))),
    Match.when("held", () => state.held.map(heldRow)),
    Match.when("unreviewed", () => state.unreviewed.map(unreviewedRow)),
    Match.when("stale", () => state.stale.map(staleRow)),
    Match.when("orphans", () => state.orphans.map(orphanRow)),
    // Only the spent accounts. One with room left is the ordinary case rather
    // than news, and a permanent row per provider would push the work that
    // needs a person down the column.
    Match.when("quota", () => state.providers.filter(exhausted).map(quotaRow)),
    Match.exhaustive,
  );

/**
 * Attention combines the exceptional states in urgency order, and each row
 * keeps the column it came from, so combining their display never combines
 * their actions.
 *
 * Stale sits above unreviewed: an overtaken branch under review is about to
 * cost a review that could never land, while an unreviewed one costs nothing
 * until the operator adopts it.
 */
export const rowsForView = (view: ViewName, state: FleetState): ReadonlyArray<ColumnRow> => {
  // The quota view is every account behind the ladder; the quota column inside
  // attention is only the spent subset, which is the part that interrupts.
  if (view === "quota") return state.providers.map(quotaRow);
  if (view !== "attention") return rowsFor(view, state);
  return [
    ...rowsFor("decisions", state),
    ...rowsFor("asks", state),
    ...rowsFor("yours", state).map(attentionRow("needs you")),
    ...rowsFor("stale", state),
    ...rowsFor("unreviewed", state),
    ...rowsFor("orphans", state),
    ...rowsFor("held", state),
    ...rowsFor("quota", state),
  ];
};

const attentionRow =
  (kind: string) =>
  (row: ColumnRow): ColumnRow => ({ ...row, label: `${kind}  ${row.label}` });

/**
 * A ready task as a row, from the task alone.
 *
 * `foreman queue` builds these with no reading of the fleet behind it, so the
 * row knows nothing about branches: whether a queued task resumes earlier
 * commits is a git read per task, which a client asking every few seconds
 * cannot afford.
 */
/**
 * The queue as `foreman queue` prints it. Each epic with a queued task leads
 * as a row of its own, just before the first of its tasks, so a reader can
 * group the tasks under it and the tasks keep their dispatch order.
 */
export const queueRows = (
  queue: ReadonlyArray<Item>,
  epics: ReadonlyArray<EpicProgress>,
): ReadonlyArray<ColumnRow> =>
  queue.flatMap((task, index) => {
    const progress = epics.find(({ epic }) => epic.id === task.parent);
    const leads =
      progress !== undefined && queue.findIndex((other) => other.parent === task.parent) === index;
    return leads ? [epicRow(progress), queueRow(task)] : [queueRow(task)];
  });

export const queueRow = (task: Item): ColumnRow => ({
  column: "queue",
  key: task.id,
  label: `${task.project}  ${task.title}`,
  detail: undefined,
  task: undefined,
  ready: task,
  worker: undefined,
  project: undefined,
  reason: undefined,
  unreviewed: undefined,
  stale: undefined,
  ask: undefined,
  failure: undefined,
  provider: undefined,
  hasWork: false,
  committed: false,
});

// The label carries the done/total count, so the row needs no second line.
const epicRow = ({ epic, children }: EpicProgress): ColumnRow => ({
  column: "queue",
  key: epic.id,
  label: `${epic.project}  ${children.filter((child) => child.status === "done").length}/${children.length}  ${epic.title}`,
  detail: undefined,
  task: epic,
  ready: undefined,
  worker: undefined,
  project: undefined,
  reason: undefined,
  unreviewed: undefined,
  stale: undefined,
  ask: undefined,
  failure: undefined,
  provider: undefined,
  hasWork: false,
  committed: false,
});

// A parked task with a branch behind it is a resumption: an earlier author
// committed and the task came back. Marked rather than counted, because the
// commit count is a read per branch per tick to say what "resume" already says.
const yoursRow = (task: Item, state: FleetState): ColumnRow => ({
  ...queueRow(task),
  column: "yours",
  label: `${task.project}  ${state.resumable.has(task.id) ? "resume  " : ""}${task.title}`,
  hasWork: state.resumable.has(task.id),
  committed: state.committed.has(task.id),
});

// The kind is shown rather than the project: in the middle columns the question
// is which model is on the work, and the project is already visible upstream.
const activeRow = (
  { task, worker, kind }: Active,
  column: "working" | "review",
  state: FleetState,
): ColumnRow => ({
  column,
  key: task.id,
  label: `${diagnosticIntent(task) ?? kind ?? "?"}  ${task.title}`,
  detail: undefined,
  task,
  ready: undefined,
  worker,
  project: undefined,
  reason: undefined,
  unreviewed: undefined,
  stale: undefined,
  ask: undefined,
  failure: undefined,
  provider: undefined,
  hasWork: worker !== undefined || state.resumable.has(task.id),
  committed: state.committed.has(task.id),
});

const landedRow = (task: Item, state: FleetState): ColumnRow => ({
  column: "landed",
  key: task.id,
  label: `${task.project}  ${task.title}`,
  detail: undefined,
  task,
  ready: undefined,
  worker: undefined,
  project: undefined,
  reason: undefined,
  unreviewed: undefined,
  stale: undefined,
  ask: undefined,
  failure: undefined,
  provider: undefined,
  hasWork: state.resumable.has(task.id),
  committed: state.committed.has(task.id),
});

const decisionRow = ({ task, worker, kind, failure }: Active, state: FleetState): ColumnRow => ({
  column: "decisions",
  key: task.id,
  // The kind leads: it is the question the column exists to answer. What is
  // behind it goes on the row's second line, so a narrow pane truncates
  // neither. An orphaned workspace names its status rather than the kind that
  // left it: done and canceled are pure cleanup, a queued task will be
  // dispatched again into a fresh workspace once this one is closed. A
  // dispatch failure names the error, because that is what the operator must
  // clear before retrying.
  label: decisionKind(task, failure),
  detail:
    failure ??
    (task.status === "done" || task.status === "canceled" || task.status === "open"
      ? task.status
      : (kind ?? "?")),
  task,
  ready: undefined,
  worker,
  project: undefined,
  reason: undefined,
  unreviewed: undefined,
  stale: undefined,
  ask: undefined,
  failure,
  provider: undefined,
  hasWork: worker !== undefined || state.resumable.has(task.id),
  committed: state.committed.has(task.id),
});

/**
 * A workspace in one of foreman's projects whose task the store has deleted.
 *
 * The label is all that is left to name it by, so it leads the row the way a
 * task id leads every other one. The directory is the detail because it is
 * what the operator has to look in to decide: nothing else records what the
 * worktree still holds.
 */
/**
 * A step the policy holds for approval. The detail says what approving starts,
 * because the operator is deciding whether that work should run, not whether
 * the task exists.
 */
const askRow = (ask: Ask): ColumnRow => ({
  column: "asks",
  key: ask.task.id,
  label: `${ask.step}  ${ask.task.title}`,
  detail: askDetail(ask),
  task: undefined,
  ready: undefined,
  worker: undefined,
  project: ask.task.project,
  reason: undefined,
  unreviewed: undefined,
  stale: undefined,
  ask,
  failure: undefined,
  provider: undefined,
  hasWork: false,
  committed: false,
});

const askDetail = ({ step, rung }: Ask): string =>
  step === "land"
    ? `reviewed by ${rung ?? "?"} and approved; approve to land it`
    : step === "review"
      ? `authored by ${rung ?? "?"}; approve to start the review`
      : `approve to start the ${step}`;

const orphanRow = (worker: Worker): ColumnRow => ({
  column: "orphans",
  key: worker.task,
  label: "no such task",
  detail: worker.directory,
  task: undefined,
  ready: undefined,
  worker,
  project: undefined,
  reason: undefined,
  unreviewed: undefined,
  stale: undefined,
  ask: undefined,
  failure: undefined,
  provider: undefined,
  hasWork: false,
  committed: false,
});

const heldRow = (held: Held): ColumnRow => ({
  column: "held",
  key: held.project,
  label: "held",
  // The reason is the part worth waiting out or fixing: a dirty tree clears
  // itself, a missing landing target never does.
  detail: held.detail,
  task: undefined,
  ready: undefined,
  worker: undefined,
  project: held.project,
  reason: held.reason,
  unreviewed: undefined,
  stale: undefined,
  ask: undefined,
  failure: undefined,
  provider: undefined,
  hasWork: false,
  committed: false,
});

/**
 * One account and what it has left, spent or healthy or unreadable.
 *
 * The label names the state when the state is news — out of quota, unreadable —
 * and is otherwise just the provider, because an account with room is the
 * ordinary case rather than anything to say. The second line is the full
 * accounting: every window with its own reset, and the rungs a spent account
 * stops, which is the answer to "what do I move off this account".
 */
const quotaRow = (provider: Provider): ColumnRow => {
  const name = `${provider.provider}${provider.plan === undefined ? "" : ` [${provider.plan}]`}`;
  const news =
    provider.unreadable !== undefined ? "unreadable" : exhausted(provider) ? "out of quota" : "";
  const stopped =
    exhausted(provider) && provider.rungs.length > 0
      ? `  ·  stops: ${provider.rungs.join(", ")}`
      : "";
  return {
    column: "quota",
    key: provider.provider,
    label: news.length > 0 ? `${news}  ${name}` : name,
    detail:
      provider.unreadable ?? `${provider.allowances.map(windowLabel).join("  ·  ")}${stopped}`,
    task: undefined,
    ready: undefined,
    worker: undefined,
    project: undefined,
    reason: undefined,
    unreviewed: undefined,
    stale: undefined,
    ask: undefined,
    failure: undefined,
    provider,
    hasWork: false,
    committed: false,
  };
};

const windowLabel = (allowance: Allowance): string =>
  `${allowance.window} ${usedLabel(allowance.usedPercent)}${
    allowance.resetsAt === undefined ? "" : ` resets ${resetsLabel(allowance.resetsAt)}`
  }`;

const unreviewedRow = (branch: Unreviewed): ColumnRow => ({
  column: "unreviewed",
  key: branch.branch,
  label: "unreviewed",
  detail: branch.title ?? "task deleted — recover by hand",
  task: undefined,
  ready: undefined,
  worker: undefined,
  project: undefined,
  reason: undefined,
  unreviewed: branch,
  stale: undefined,
  ask: undefined,
  failure: undefined,
  provider: undefined,
  hasWork: true,
  committed: true,
});

const staleRow = (branch: StaleRow): ColumnRow => ({
  column: "stale",
  key: branch.branch,
  label: "stale",
  // The cause is the part worth acting on: trunk having deleted what the
  // branch patches is a different problem from a content conflict, and the
  // paths name what a rebase would have to face.
  detail: branch.modifyDelete
    ? `cannot land: trunk deleted ${branch.paths.join(", ")}`
    : `cannot land: conflicts on ${branch.paths.join(", ")}`,
  task: branch.task,
  ready: undefined,
  worker: undefined,
  project: branch.project,
  reason: undefined,
  unreviewed: undefined,
  stale: branch,
  ask: undefined,
  failure: undefined,
  provider: undefined,
  hasWork: true,
  committed: true,
});
