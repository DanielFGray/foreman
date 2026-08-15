import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createSignal, For, Show, type Accessor } from "solid-js";
import type { Active, Climbing, FleetState, Orphan } from "./dispatcher.ts";
import type { Worker } from "./fleet.ts";
import { reviewedBy, rungOf, type Item, type ReadyTask } from "./prog.ts";

/**
 * Every command the view can give the dispatcher.
 *
 * The view never builds an Effect; it only names the command and the row it
 * acts on. The effect wiring in dashboard.tsx turns each callback into a
 * forked run against the live dispatcher, and a test turns them into spies.
 */
export interface Controls {
  readonly quit: () => void;
  readonly togglePause: () => void;
  readonly toggleConsole: () => void;
  readonly focus: (worker: Worker) => void;
  readonly retry: (task: Item) => void;
  readonly release: (task: Item) => void;
  readonly close: (task: Item) => void;
  readonly climb: (task: Climbing) => void;
  readonly descend: (task: Climbing) => void;
  readonly unassign: (task: Climbing) => void;
  readonly onboard: (project: string) => void;
  readonly adopt: (orphan: Orphan) => void;
}

/** The pipeline: work moving left to right. */
const STAGES = ["queue", "working", "review", "landed"] as const;

/** What the dispatcher needs a person to answer, which is normally nothing. */
const PANELS = ["decisions", "yours", "held", "stranded"] as const;

/** Every selectable column, in the order the cursor moves through them. */
const COLUMNS = [...STAGES, ...PANELS] as const;
type ColumnName = (typeof COLUMNS)[number];

/**
 * The columns with something in them, which are the only ones drawn.
 *
 * An empty box is a claim on the screen that pays nothing back: the count in
 * its title is already zero, and a fleet with nothing held, nothing stranded
 * and no decision waiting is the ordinary case rather than news. Drawing them
 * anyway costs the columns that do hold work the width they need to show a
 * title. Nothing is reachable that is not drawn, so the cursor and the keys
 * follow this too.
 */
const drawn = (names: ReadonlyArray<ColumnName>, state: FleetState): ReadonlyArray<ColumnName> =>
  names.filter((name) => rowsFor(name, state).length > 0);

export type DecisionKind = "author vanished" | "reviewer vanished" | "orphaned workspace";

/**
 * Which kind of decision a row is, from the task's status.
 *
 * Status decides, not labels. A workspace left behind by a failed spawn still
 * carries its by-* label while its task sits back in the queue, so naming from
 * the labels alone would call it an author that vanished; the task's status —
 * neither claimed nor under review — is what makes it residue.
 */
export const decisionKind = (task: Item): DecisionKind =>
  task.status === "reviewing"
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
interface ColumnRow {
  readonly key: string;
  readonly label: string;
  /** The full task, for rows that came out of a claimed status. */
  readonly task: Item | undefined;
  /** The queued task, which has never been claimed and so never has a status. */
  readonly ready: ReadyTask | undefined;
  readonly worker: Worker | undefined;
  readonly project: string | undefined;
  /** The branch behind a stranded row, which no task in the fleet accounts for. */
  readonly orphan: Orphan | undefined;
}

type Action =
  | "retry"
  | "release"
  | "close"
  | "takeOver"
  | "focus"
  | "climb"
  | "descend"
  | "unassign"
  | "onboard"
  | "adopt";

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
  queue: ["climb", "descend", "unassign"],
  working: ["focus", "climb", "descend", "release"],
  review: ["focus", "climb", "descend", "release"],
  landed: [],
  decisions: ["retry", "takeOver", "release", "close", "unassign"],
  yours: ["descend", "unassign"],
  held: ["onboard"],
  stranded: ["adopt"],
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
  "author vanished": ["retry", "takeOver", "release"],
  "reviewer vanished": ["retry", "takeOver", "release"],
  "orphaned workspace": ["close", "unassign"],
};

/**
 * The pipeline, drawn from whatever the dispatcher last observed.
 *
 * A single cursor walks every column that has something in it — the stages,
 * then the panels holding what the dispatcher needs a person to answer. Keys
 * run the command that the selected row and column allow; a key whose action a
 * row cannot take is simply ignored.
 */
export const Pipeline = (props: {
  readonly state: Accessor<FleetState>;
  readonly controls: Controls;
}) => {
  const [wanted, setWanted] = createSignal<ColumnName>("queue");
  const [row, setRow] = createSignal(0);

  const stages = (): ReadonlyArray<ColumnName> => drawn(STAGES, props.state());
  const panels = (): ReadonlyArray<ColumnName> => drawn(PANELS, props.state());
  const columns = (): ReadonlyArray<ColumnName> => [...stages(), ...panels()];

  // A column empties under the cursor — the last decision is answered, the last
  // queued task is dispatched — and goes. The cursor lands on the nearest
  // column still drawn to its left, or the first one left on screen.
  const column = (): ColumnName => {
    const here = columns();
    if (here.includes(wanted())) return wanted();
    const index = COLUMNS.indexOf(wanted());
    return here.filter((name) => COLUMNS.indexOf(name) < index).at(-1) ?? here[0] ?? wanted();
  };

  const rows = (): ReadonlyArray<ColumnRow> => rowsFor(column(), props.state());

  // The cursor clamps to the column it sits in: a shrinking column never
  // strands the selection past its last row.
  const selected = (): number | undefined => {
    const count = rows().length;
    if (count === 0) return undefined;
    return Math.min(row(), count - 1);
  };

  const selectedFor =
    (name: ColumnName): Accessor<number | undefined> =>
    () =>
      column() === name ? selected() : undefined;

  const step = (delta: number) => {
    const count = rows().length;
    if (count === 0) return;
    setRow((current) => Math.min(Math.max(current + delta, 0), count - 1));
  };

  // Only what is drawn is reachable: a key aimed at a column nobody can see
  // would read as a dead press.
  const moveColumn = (delta: number) => {
    const drawn = columns();
    const index = drawn.indexOf(column());
    const next = drawn[(index + delta + drawn.length) % drawn.length];
    if (next) {
      setWanted(next);
      setRow(0);
    }
  };

  const apply = (action: Action) => {
    if (!ACTIONS[column()].includes(action)) return;
    const index = selected();
    if (index === undefined) return;
    const target = rows()[index];
    if (!target) return;
    if (column() === "decisions" && target.task) {
      if (!DECISION_ACTIONS[decisionKind(target.task)].includes(action)) return;
    }
    switch (action) {
      case "retry":
        if (target.task) props.controls.retry(target.task);
        break;
      case "release":
        if (target.task) props.controls.release(target.task);
        break;
      case "close":
        if (target.task) props.controls.close(target.task);
        break;
      case "takeOver":
        // A vanished worker can still be taken over when its workspace
        // exists; a decision with no workspace is retry or release only.
        if (target.worker) props.controls.focus(target.worker);
        break;
      case "focus":
        if (target.worker) props.controls.focus(target.worker);
        break;
      case "climb":
        if (target.task) props.controls.climb(target.task);
        else if (target.ready) props.controls.climb(target.ready);
        break;
      case "descend":
        // A row without a rung label is at the bottom, where there is nothing
        // to lower. The key is ignored rather than silently writing a label
        // foreman itself would never have written.
        if (target.task && rungOf(target.task) !== undefined) props.controls.descend(target.task);
        else if (target.ready && rungOf(target.ready) !== undefined)
          props.controls.descend(target.ready);
        break;
      case "unassign":
        // A review-by-* label with a live reviewer behind it is an assignment,
        // not a stale one, and clearing it would let a second reviewer be
        // dispatched into the same task.
        if (target.task && staleReview(target.task, target.worker))
          props.controls.unassign(target.task);
        else if (target.ready && staleReview(target.ready, undefined))
          props.controls.unassign(target.ready);
        break;
      case "onboard":
        if (target.project) props.controls.onboard(target.project);
        break;
      case "adopt":
        if (target.orphan) props.controls.adopt(target.orphan);
        break;
    }
  };

  useKeyboard((key) => {
    switch (key.name) {
      case "q":
        props.controls.quit();
        break;
      case "p":
        props.controls.togglePause();
        break;
      case "f12":
        props.controls.toggleConsole();
        break;
      case "up":
      case "k":
        step(-1);
        break;
      case "down":
      case "j":
        step(1);
        break;
      case "left":
      case "h":
        moveColumn(-1);
        break;
      case "right":
      case "l":
        moveColumn(1);
        break;
      case "r":
        apply("retry");
        break;
      case "t":
        apply("takeOver");
        break;
      case "f":
        apply("focus");
        break;
      case "e":
        apply("climb");
        break;
      case "x":
        apply("descend");
        break;
      case "u":
        apply("unassign");
        break;
      case "d":
        apply("release");
        break;
      case "c":
        apply("close");
        break;
      case "o":
        apply("onboard");
        break;
      case "s":
        apply("adopt");
        break;
    }
  });

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      {/* A row goes when the last column in it does: an empty row still claims
          half the screen, which is the same empty box one column wider. */}
      <Row columns={stages} state={props.state} selected={selectedFor} fill />
      <Row columns={panels} state={props.state} selected={selectedFor} fill={false} />
      <Status state={props.state} />
    </box>
  );
};

/**
 * The tallest a row of panels grows to before its columns start scrolling.
 *
 * Stranded branches arrive by the dozen after a bad night, and a report of them
 * that pushes the pipeline off the screen has answered the wrong question.
 */
const PANEL_LINES = 8;

/**
 * The lines a column spends on itself: the two borders, and one the scrollbox
 * holds back for a horizontal scrollbar it never shows. Measured from a render,
 * because a row short by one hides a row of the report.
 */
const CHROME = 3;

/**
 * One band of columns, which is nothing at all when it holds no column.
 *
 * `fill` decides who gets the space nobody claimed. The pipeline takes it,
 * because that is the screen; the panels hug what they hold, because a single
 * held project stretched down half the terminal is an empty box wearing one
 * row as a disguise — it was the largest thing on screen precisely when it had
 * the least to say. Two lines of border plus its rows, capped, is the whole
 * height it earns.
 */
const Row = (props: {
  readonly columns: Accessor<ReadonlyArray<ColumnName>>;
  readonly state: Accessor<FleetState>;
  readonly selected: (name: ColumnName) => Accessor<number | undefined>;
  readonly fill: boolean;
}) => {
  const height = () =>
    Math.min(
      Math.max(...props.columns().map((name) => rowsFor(name, props.state()).length)),
      PANEL_LINES,
    ) + CHROME;

  return (
    <Show when={props.columns().length > 0}>
      <box
        style={
          props.fill
            ? { flexDirection: "row", flexGrow: 1, flexBasis: 0, minHeight: 0 }
            : { flexDirection: "row", flexGrow: 0, flexShrink: 0, height: height() }
        }
      >
        <For each={props.columns()}>
          {(name) => (
            <Column
              title={name}
              rows={() => rowsFor(name, props.state())}
              selected={props.selected(name)}
            />
          )}
        </For>
      </box>
    </Show>
  );
};

/**
 * One stage of the pipeline.
 *
 * flexBasis 0 rather than plain flexGrow: growth only shares out the space
 * left over, so a column full of long titles would otherwise starve an empty
 * one down to a sliver and the pipeline would look broken whenever it was
 * lopsided — which is most of the time.
 *
 * The rows live in a scrollbox because a stage holds however much work the
 * backlog has, which is routinely five times the lines the box can draw. A
 * plain box does not clip its children: the surplus rows are drawn straight
 * over the border, the neighbouring column and the status lines below, and the
 * whole screen reads as corrupted. The scrollbox both clips and gives the
 * cursor somewhere to go.
 */
const Column = (props: {
  readonly title: string;
  readonly rows: Accessor<ReadonlyArray<ColumnRow>>;
  readonly selected: Accessor<number | undefined>;
}) => {
  let viewport: ScrollBoxRenderable | undefined;

  // The cursor is what scrolls the column; there is no separate scroll
  // position to get out of step with it. Selecting past the fold brings the
  // row up, so j and k never walk the selection off the screen.
  createEffect(() => {
    const index = props.selected();
    const row = index === undefined ? undefined : props.rows()[index];
    if (row) viewport?.scrollChildIntoView(rowId(props.title, row.key));
  });

  return (
    <box
      style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, minWidth: 0, border: true }}
      title={`${props.title} ${props.rows().length}`}
    >
      <scrollbox
        ref={(element) => (viewport = element)}
        style={{ flexGrow: 1, minWidth: 0, rootOptions: { flexGrow: 1, minWidth: 0 } }}
        scrollX={false}
      >
        <For each={props.rows()}>
          {(row, index) => (
            <text
              id={rowId(props.title, row.key)}
              style={{
                height: 1,
                flexShrink: 0,
                ...(index() === props.selected() ? SELECTED : PLAIN),
              }}
            >
              {`${index() === props.selected() ? "> " : "  "}${row.label}`}
            </text>
          )}
        </For>
      </scrollbox>
    </box>
  );
};

/**
 * The selected row, painted rather than inverted.
 *
 * `inverse` swaps a cell's two colours, and opentui's text defaults are
 * `#FFFFFF` on `transparent` — so the swap put white in the background and left
 * the glyphs transparent. The cursor redacted the one row the operator was
 * reading. Naming both colours is the only way to be sure they differ.
 */
const SELECTED = { bg: "#1f4d8f", fg: "#ffffff" } as const;

/**
 * Those same defaults, named so that leaving a row restores them.
 *
 * A style key that is simply absent is not a style key set back: the renderable
 * keeps whatever it was last given, so the highlight stayed on the row the
 * cursor had left until the next tick rebuilt the rows. Both states have to
 * name both colours.
 */
const PLAIN = { bg: "transparent", fg: "#FFFFFF" } as const;

/** Renderable ids are global, so a row's key is only unique within its column. */
const rowId = (column: string, key: string): string => `${column}:${key}`;

/**
 * Whether the pipeline is moving, and what to press.
 *
 * This is the one thing always on screen: with every column empty the fleet
 * still has to say whether it is paused or simply out of work.
 */
const Status = (props: { readonly state: Accessor<FleetState> }) => (
  <box style={{ flexDirection: "column", flexShrink: 0 }}>
    <text style={{ height: 1 }}>
      {`${props.state().paused ? "paused" : "running"}  ·  ${props.state().decisions.length} awaiting a decision`}
    </text>
    <text style={{ height: 1 }}>
      {
        "r retry  t take over  f focus  e climb  x descend  u unassign  d release  c close  o onboard  s send for review"
      }
    </text>
    <text style={{ height: 1 }}>{"p pause  F12 log  q quit"}</text>
  </box>
);

const rowsFor = (column: ColumnName, state: FleetState): ReadonlyArray<ColumnRow> => {
  switch (column) {
    case "queue":
      return state.queue.map(readyRow);
    case "working":
      return state.working.map(activeRow);
    case "review":
      return state.review.map(activeRow);
    case "landed":
      return state.landed.map(landedRow);
    case "decisions":
      return state.decisions.map(decisionRow);
    case "yours":
      return state.yours.map(readyRow);
    case "held":
      return state.held.map(heldRow);
    case "stranded":
      return state.orphans.map(orphanRow);
  }
};

const readyRow = (task: ReadyTask): ColumnRow => ({
  key: task.id,
  label: `${task.project}  ${task.title}`,
  task: undefined,
  ready: task,
  worker: undefined,
  project: undefined,
  orphan: undefined,
});

// The kind is shown rather than the project: in the middle columns the question
// is which model is on the work, and the project is already visible upstream.
const activeRow = ({ task, worker, kind }: Active): ColumnRow => ({
  key: task.id,
  label: `${kind ?? "?"}  ${task.title}`,
  task,
  ready: undefined,
  worker,
  project: undefined,
  orphan: undefined,
});

const landedRow = (task: Item): ColumnRow => ({
  key: task.id,
  label: `${task.project}  ${task.title}`,
  task,
  ready: undefined,
  worker: undefined,
  project: undefined,
  orphan: undefined,
});

const decisionRow = ({ task, worker, kind }: Active): ColumnRow => ({
  key: task.id,
  // The reason leads: it is the question the column exists to answer, and it
  // is the half that must survive a narrow terminal truncating the line. An
  // orphaned workspace names its status rather than the kind that left it:
  // done and canceled are pure cleanup, a queued task will be dispatched again
  // into a fresh workspace once this one is closed.
  label:
    decisionKind(task) === "orphaned workspace"
      ? `orphaned workspace  ${task.id}  ${task.status}`
      : `${decisionKind(task)}  ${task.id}  ${kind ?? "?"}`,
  task,
  ready: undefined,
  worker,
  project: undefined,
  orphan: undefined,
});

const heldRow = (project: string): ColumnRow => ({
  key: project,
  label: project,
  task: undefined,
  ready: undefined,
  worker: undefined,
  project,
  orphan: undefined,
});

// A branch whose task is gone has no id to dispatch against, so the row says
// so rather than offering a key that would do nothing.
const orphanRow = (orphan: Orphan): ColumnRow => ({
  key: orphan.branch,
  label: `${orphan.branch}  ${orphan.title ?? "task deleted — recover by hand"}`,
  task: undefined,
  ready: undefined,
  worker: undefined,
  project: undefined,
  orphan,
});
