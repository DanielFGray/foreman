import { DateTime, Match } from "effect";
import type {
  Active,
  Climbing,
  FleetState,
  Held,
  Provider,
  StaleRow,
  Unreviewed,
} from "./dispatcher.ts";
import { exhausted, type Allowance } from "./quota.ts";
import { nextDispatch } from "./dispatcher.ts";
import type { Worker } from "./fleet.ts";
import { diagnosticIntent, reviewedBy, rungOf, type Item, type ReadyTask } from "./prog.ts";

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

/**
 * The views the cursor follows a tracked task through.
 *
 * A task climbs queue → working → review and the highlight chases it, and a
 * task parked at the operator or needing a decision is still live work, so
 * attention is followed too. Landed is not: a task that landed is finished,
 * and chasing it into history only walks the operator out of the work still to
 * do. Landing ends the follow, and the cursor stays where it was.
 */
export const FOLLOW_VIEWS = ["queue", "working", "review", "attention"] as const;

/**
 * The non-empty views, which are the only tabs drawn.
 *
 * An empty box is a claim on the screen that pays nothing back: the count in
 * its title is already zero, and a fleet with nothing held, nothing unread and
 * no decision waiting is the ordinary case rather than news. Nothing is
 * reachable that is not drawn, so the cursor and keys follow this too.
 */
export const drawn = (state: FleetState): ReadonlyArray<ViewName> =>
  VIEWS.filter((name) => rowsForView(name, state).length > 0);

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
 * Whether a review-by-* label has no live reviewer behind it, so it is stale.
 *
 * The world records whether a reviewer was dispatched, not whether that
 * reviewer is still alive. A task that is open — waiting in the queue — with a
 * review-by-* label is stale by definition, because a real review keeps the
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
  readonly ready: ReadyTask | undefined;
  readonly worker: Worker | undefined;
  readonly project: string | undefined;
  /** The hold's reason, for rows whose actions depend on what is holding it. */
  readonly reason: Held["reason"] | undefined;
  /** The branch behind an unreviewed row, whose commits nothing is reading. */
  readonly unreviewed: Unreviewed | undefined;
  /** The overtaken branch behind a stale row, whose review could not land. */
  readonly stale: StaleRow | undefined;
  /** The account behind a quota row, whose every window the preview reads. */
  readonly provider: Provider | undefined;
  /** The error behind a dispatch-failed decision row. */
  readonly failure: string | undefined;
  readonly hasWork: boolean;
  readonly committed: boolean;
}

const ACTIONS_LIST = [
  "complete",
  "retry",
  "release",
  "close",
  "takeOver",
  "pin",
  "focus",
  "kill",
  "intervene",
  "descend",
  "unassign",
  "onboard",
  "adopt",
] as const;

/** Something a key does to the selected row. */
export type Action = (typeof ACTIONS_LIST)[number];

/** Something a key does to the screen, whatever row the cursor is on. */
export type Global = "quit" | "dispatch" | "log" | "stats" | "viewLeft" | "viewRight";

export type Command = Action | Global;

/**
 * Which keys mean something in which column.
 *
 * Landed is history and takes no action; a queue task can only climb, because
 * releasing a task that was never claimed has nothing to undo. The same key
 * does not change meaning between columns.
 *
 * The two corrections — `descend` and `unassign` — are offered wherever their
 * labels could have been written, and a row without the label ignores the key
 * rather than doing nothing to a claim. `descend` only reaches a row that
 * carries a `rung-*` label: a task without one is already at the bottom, and
 * there is nothing to lower. `unassign` only reaches a row whose review-by-*
 * label has no live reviewer behind it.
 *
 * `yours` takes no answer key, and that is the design rather than an omission.
 * A task waits there because a question about it is unanswered, and a single
 * key to put it back would hand the next agent the same unanswered question —
 * the exact failure the column exists to prevent. It leaves when the operator
 * writes the decision into the task and removes its `rung-human` label, in
 * that order, with prog. The two corrections do reach it: a task parked at the
 * operator is exactly the sort of rung that can turn out to have been written
 * without being earned, and no other column shows a `rung-human` task to lower
 * it from.
 */
const ACTIONS: Record<ColumnName, ReadonlyArray<Action>> = {
  queue: ["pin", "complete", "intervene", "descend", "unassign"],
  working: ["pin", "focus", "kill", "intervene", "descend", "release"],
  review: ["pin", "focus", "kill", "intervene", "descend", "release"],
  landed: [],
  decisions: ["retry", "takeOver", "intervene", "release", "close", "unassign"],
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
 * canceled task — so it is only ever closed, or, when it carries a review-by-*
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

/**
 * Every key the dashboard interprets, in one table.
 *
 * The screen binds what this lists and reports the key back by name; nothing
 * below this file knows a key's meaning, and nothing above it knows a key's
 * name. Changing a binding is changing one row here.
 *
 * The modifier is the design, not decoration. Letters type: the operator
 * filters by typing a task id, which is how they act on the one you named to
 * them, so no bare letter can also be a command. Two keys therefore cannot be
 * taken however good the mnemonic — `ctrl-c`, which fzf aborts on, and the
 * navigation pair `ctrl-n`/`ctrl-p`, which are how the cursor moves now that
 * `j` and `k` type. Everything else fzf uses for line editing is fair game,
 * because the text being edited here is only ever an id.
 *
 * `also` lists keys bound to the same command and left out of the footer,
 * where a second key is the obvious one but not the one worth advertising.
 */
const KEYS: Record<Command, Binding> = {
  complete: { key: "ctrl-d", label: "done" },
  retry: { key: "ctrl-r", label: "retry" },
  takeOver: { key: "ctrl-t", label: "take over" },
  pin: { key: "alt-p", label: "pin" },
  focus: { key: "ctrl-f", label: "focus" },
  kill: { key: "ctrl-k", label: "kill" },
  intervene: { key: "ctrl-e", label: "intervene" },
  descend: { key: "ctrl-x", label: "descend" },
  unassign: { key: "ctrl-a", label: "unassign" },
  release: { key: "ctrl-b", label: "release" },
  close: { key: "ctrl-w", label: "close" },
  onboard: { key: "ctrl-o", label: "onboard" },
  adopt: { key: "ctrl-v", label: "adopt" },

  quit: { key: "ctrl-q", label: "quit" },
  dispatch: { key: "ctrl-space", label: "dispatch" },
  log: { key: "f12", label: "log" },
  stats: { key: "ctrl-g", label: "stats" },
  viewLeft: { key: "shift-tab", also: ["left"], label: "view" },
  viewRight: { key: "tab", also: ["right"], label: "view" },
};

interface Binding {
  /** The key the footer advertises. */
  readonly key: string;
  /** Keys that mean the same thing and are bound without being advertised. */
  readonly also?: ReadonlyArray<string>;
  readonly label: string;
}

/**
 * The keys the screen binds, which is every key foreman interprets.
 *
 * Enter and Escape are on the end because they answer a prompt rather than
 * running a command, and fzf would otherwise accept and abort on them.
 */
export const BOUND_KEYS: ReadonlyArray<string> = [
  ...Object.values(KEYS).flatMap((binding) => [binding.key, ...(binding.also ?? [])]),
  "enter",
  "esc",
];

const BY_KEY = new Map<string, Command>(
  Object.entries(KEYS).flatMap(([command, binding]) =>
    [binding.key, ...(binding.also ?? [])].map((key) => [key, command as Command] as const),
  ),
);

/** What the operator meant by a key, or nothing if it means nothing here. */
export const commandFor = (key: string): Command | undefined => BY_KEY.get(key);

export const isAction = (command: Command): command is Action =>
  (ACTIONS_LIST as ReadonlyArray<string>).includes(command);

/** A key as the footer writes it, where `^e` is what an operator reads. */
export const showKey = (command: Command): string =>
  KEYS[command].key.replace(/^ctrl-/, "^").replace(/^shift-/, "S-");

/** The commands that are meaningful for this exact row, not just its column. */
export const actionsFor = (
  column: ColumnName,
  row: ColumnRow | undefined,
): ReadonlyArray<Action> => {
  if (!row) return [];
  if (row.task?.type === "epic") return row.column === "queue" ? ["pin"] : [];
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
      Match.when(
        "descend",
        () =>
          (row.task !== undefined && rungOf(row.task) !== undefined) ||
          (row.ready !== undefined && rungOf(row.ready) !== undefined),
      ),
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
      // Any row naming a task can be pinned, claimed or not: a pin says where
      // the work sits in the queue if it ever returns there, and a rejected
      // review puts it back.
      Match.when("pin", () => row.ready !== undefined || row.task !== undefined),
      Match.when("onboard", () => row.project !== undefined && row.reason === "dirty"),
      Match.when("adopt", () => row.unreviewed !== undefined),
      Match.exhaustive,
    ),
  );
};

/** The task a row's corrections and interventions act on, whichever half holds it. */
export const climbing = (row: ColumnRow): Climbing | undefined => row.task ?? row.ready;

/**
 * The tab strip, as one header line.
 *
 * The view names are single words so a click lands on one: fzf reports the
 * word under the pointer, and that word is the whole address of the tab.
 */
export const tabs = (state: FleetState, current: ViewName): string =>
  drawn(state)
    .map((name) => {
      const count = rowsForView(name, state).length;
      return name === current ? `[${name} ${count}]` : ` ${name} ${count} `;
    })
    .join(" ");

/**
 * Whether the pipeline is moving, and how stale this reading is.
 *
 * This is the one thing always on screen: with every column empty the fleet
 * still has to say whether it is paused, draining, or simply out of work.
 */
export const statusLine = (state: FleetState, now: number): string =>
  [pinnedStatus(state), state.dispatch, readAge(state, now), attentionStatus(state)]
    .filter((part) => part !== undefined)
    .join("  ·  ");

/**
 * The keys that do something here: what the selected row takes, and under it
 * what is always available.
 *
 * Two lines because they answer different questions and only the first one
 * changes as the cursor moves — and because one line of both is longer than
 * the list is wide, so the always-available half is what a narrow pane would
 * truncate away.
 *
 * The dispatch key's label names the state it moves to rather than the state
 * it is in, because the three cycle and the operator is choosing where to stop.
 */
export const keyLine = (actions: ReadonlyArray<Action>, state: FleetState): string =>
  [
    actions.map((action) => `${showKey(action)} ${KEYS[action].label}`).join("  "),
    // Ordered so that a narrow pane truncates the hint rather than a key:
    // typing is self-evident the moment the operator does it, and the prompt
    // is right there showing what was typed.
    [
      `${showKey("viewLeft")}/${showKey("viewRight")} view`,
      "^p/^n move",
      `${showKey("dispatch")} ${nextDispatch(state.dispatch)}`,
      `${showKey("log")} log`,
      `${showKey("quit")} quit`,
      "type to filter",
    ].join("  "),
  ]
    .filter((line) => line.length > 0)
    .join("\n");

/**
 * Everything known about the selected row, for the preview pane.
 *
 * The pane is off to one side rather than squeezed into the list, so this is
 * free to say the whole of what a row is — including the task's description,
 * which the one-line label never had room for and which is the thing an
 * operator deciding what to do about a row actually wants to read.
 *
 * The description is emitted whole, never truncated: the pane wraps and
 * scrolls, so cutting it here would lose text the terminal could have shown.
 */
export const previewOf = (row: ColumnRow): string => {
  const task = row.task ?? row.ready;
  const lines: Array<string> = [row.key, row.label, ""];
  if (task) {
    lines.push(
      `view      ${viewLabel(sourceView(row.column))}`,
      `status    ${row.task?.status ?? "ready"}`,
      `project   ${task.project}`,
      `priority  ${task.priority}`,
      `labels    ${task.labels.join(", ") || "none"}`,
    );
  }
  if (row.worker) {
    lines.push(
      `worker    ${row.worker.state}`,
      `worktree  ${row.worker.worktree ?? row.worker.directory}`,
      `roles     ${[...row.worker.roles].map(([role, state]) => `${role}:${state}`).join(", ")}`,
    );
  }
  if (row.failure !== undefined) lines.push("", `failure   ${row.failure}`);
  if (row.project !== undefined && !task) lines.push(`project   ${row.project}`);
  if (row.unreviewed) {
    lines.push(
      `project   ${row.unreviewed.project}`,
      `branch    ${row.unreviewed.branch}`,
      `task      ${row.unreviewed.task} (${row.unreviewed.status ?? "deleted"})`,
    );
  }
  if (row.stale) {
    lines.push(
      `branch    ${row.stale.branch}`,
      `paths     ${row.stale.paths.join(", ")}`,
      row.stale.modifyDelete
        ? "cause     the trunk deleted what this branch patches"
        : "cause     the trunk moved and the work conflicts",
    );
  }
  // An account's windows read best one per line in the pane that wraps and
  // scrolls, which is the whole reason they are not squeezed into the row.
  if (row.provider !== undefined) {
    lines.push(
      ...(row.provider.unreadable !== undefined
        ? [`unreadable  ${row.provider.unreadable}`]
        : row.provider.allowances.map(
            (allowance) =>
              `  ${allowance.window.padEnd(16)} ${String(allowance.usedPercent).padStart(3)}%${
                allowance.resetsAt === undefined
                  ? ""
                  : `  resets in ${resetLabel(allowance.resetsAt)}`
              }`,
          )),
    );
    if (
      row.provider.unreadable === undefined &&
      exhausted(row.provider) &&
      row.provider.rungs.length > 0
    )
      lines.push(`stops: ${row.provider.rungs.join(", ")}`);
  }
  // Whichever kind of task the row carries: a queued one is read in the same
  // shape as a claimed one, so the pane says the same thing about both.
  if (task?.description) lines.push("", task.description);
  return lines.join("\n");
};

export const viewLabel = (view: ViewName): string =>
  view === "attention" ? "Attention" : `${view[0]?.toUpperCase()}${view.slice(1)}`;

export const sourceView = (column: ColumnName): ViewName =>
  column === "decisions" ||
  column === "yours" ||
  column === "held" ||
  column === "unreviewed" ||
  column === "stale" ||
  column === "orphans"
    ? "attention"
    : column;

const attentionStatus = (state: FleetState): string => {
  const count = rowsForView("attention", state).length;
  return `${count} ${count === 1 ? "needs" : "need"} attention`;
};

/**
 * How long ago the dispatcher last read the world.
 *
 * Seconds mean a fleet cycling on its poll interval. Minutes mean a tick is
 * inside something long — a landing running a project's test suite is the
 * usual one — and the same reading is what a wedged daemon shows, which is the
 * point: an operator who can see the number can tell those apart by watching
 * it, instead of reading the process tree.
 */
const readAge = (state: FleetState, now: number): string => {
  const observedAt = state.observedAt;
  if (observedAt === undefined) return "starting";
  const seconds = Math.max(0, Math.round((now - DateTime.toEpochMillis(observedAt)) / 1000));
  if (seconds < 60) return `read ${seconds}s ago`;
  if (seconds < 3600) return `read ${Math.floor(seconds / 60)}m ago`;
  return `read ${Math.floor(seconds / 3600)}h ago`;
};

/**
 * How much pinned work is left to do, when any is pinned.
 *
 * Counted off the queue rather than the label set: a pinned task that is
 * claimed, under review or finished is not work the fleet still has to reach,
 * and a count that included it would keep saying "3 pinned" while the last one
 * landed.
 */
const pinnedStatus = (state: FleetState): string | undefined => {
  if (state.pinned.size === 0) return undefined;
  const ready = state.queue.filter((task) => state.pinned.has(task.id)).length;
  return `pinned: ${ready} ready`;
};

const rowsFor = (column: ColumnName, state: FleetState): ReadonlyArray<ColumnRow> =>
  Match.value(column).pipe(
    Match.when("queue", () => [
      ...state.epics.map(epicRow),
      ...state.queue.map((task) => readyRow(task, "queue", state)),
    ]),
    Match.when("working", () => state.working.map((active) => activeRow(active, "working", state))),
    Match.when("review", () => state.review.map((active) => activeRow(active, "review", state))),
    Match.when("landed", () => state.landed.map((task) => landedRow(task, state))),
    Match.when("decisions", () => state.decisions.map((active) => decisionRow(active, state))),
    Match.when("yours", () => state.yours.map((task) => readyRow(task, "yours", state))),
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

// A queued task with a branch behind it is not new work, it is a resumption:
// an earlier author committed and the task came back here. Marked rather than
// listed apart, because it is still ordinary queue work and the queue's own
// order decides when it goes out. Marked rather than counted, because the
// commit count is a read per branch per tick to say what "resume" already says.
const readyRow = (task: ReadyTask, column: "queue" | "yours", state: FleetState): ColumnRow => ({
  column,
  key: task.id,
  label: `${state.pinned.has(task.id) ? "📌 " : ""}${task.project}  ${state.resumable.has(task.id) ? "resume  " : ""}${task.title}`,
  detail: undefined,
  task: undefined,
  ready: task,
  worker: undefined,
  project: undefined,
  reason: undefined,
  unreviewed: undefined,
  stale: undefined,
  failure: undefined,
  provider: undefined,
  hasWork: state.resumable.has(task.id),
  committed: state.committed.has(task.id),
});

const epicRow = ({ epic, children }: FleetState["epics"][number]): ColumnRow => {
  const complete = children.filter((child) => child.status === "done").length;
  return {
    column: "queue",
    key: epic.id,
    label: `${epic.labels.includes("pin") ? "📌 " : ""}${epic.project}  ${complete}/${children.length}  ${epic.title}`,
    // No second line: the count is already on the label, and a row costing two
    // lines to say one thing twice pushes the ready work off a short pane.
    detail: undefined,
    task: epic,
    ready: undefined,
    worker: undefined,
    project: undefined,
    reason: undefined,
    unreviewed: undefined,
    stale: undefined,
    failure: undefined,
    provider: undefined,
    hasWork: false,
    committed: false,
  };
};

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
    failure: undefined,
    provider,
    hasWork: false,
    committed: false,
  };
};

const windowLabel = (allowance: Allowance): string =>
  `${allowance.window} ${allowance.usedPercent}%${
    allowance.resetsAt === undefined ? "" : ` resets in ${resetLabel(allowance.resetsAt)}`
  }`;

/** How long until a window resets, in the coarsest unit that is still true. */
const resetLabel = (at: Date): string => {
  const minutes = Math.max(0, Math.round((at.getTime() - Date.now()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
};

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
  failure: undefined,
  provider: undefined,
  hasWork: true,
  committed: true,
});
