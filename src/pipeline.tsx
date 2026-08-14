import { createTextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createSignal, For, type Accessor } from "solid-js";
import type { Active, Climbing, FleetState, Orphan } from "./dispatcher.ts";
import type { Worker } from "./fleet.ts";
import type { Item, ReadyTask } from "./prog.ts";

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
  readonly onboard: (project: string) => void;
  readonly adopt: (orphan: Orphan) => void;
}

/** The eight selectable stages, in the order the cursor moves through them. */
const COLUMNS = [
  "focus",
  "queue",
  "working",
  "review",
  "landed",
  "decisions",
  "yours",
  "held",
  "stranded",
] as const;
type ColumnName = (typeof COLUMNS)[number];

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

type Action = "retry" | "release" | "close" | "takeOver" | "focus" | "climb" | "onboard" | "adopt";

/**
 * Which keys mean something in which column.
 *
 * Landed is history and takes no action; a queue task can only climb, because
 * releasing a task that was never claimed has nothing to undo. The same key
 * does not change meaning between columns.
 *
 * `yours` takes no key at all, and that is the design rather than an omission.
 * A task waits there because a question about it is unanswered, and a single
 * key to put it back would hand the next agent the same unanswered question —
 * the exact failure the column exists to prevent. It leaves when the operator
 * writes the decision into the task and removes its `rung-human` label, in
 * that order, with prog.
 */
const ACTIONS: Record<ColumnName, ReadonlyArray<Action>> = {
  focus: ["climb"],
  queue: ["climb"],
  working: ["focus", "climb", "release"],
  review: ["focus", "climb", "release"],
  landed: [],
  decisions: ["retry", "takeOver", "release", "close"],
  yours: [],
  held: ["onboard"],
  stranded: ["adopt"],
};

/**
 * Which decisions allow which answers, because the answers differ.
 *
 * A vanished author or reviewer can be retried, taken over, or released. An
 * orphaned workspace has no claim to undo — releasing would reopen a done or
 * canceled task — so it is only ever closed.
 */
const DECISION_ACTIONS: Record<DecisionKind, ReadonlyArray<Action>> = {
  "author vanished": ["retry", "takeOver", "release"],
  "reviewer vanished": ["retry", "takeOver", "release"],
  "orphaned workspace": ["close"],
};

/**
 * The pipeline, drawn from whatever the dispatcher last observed.
 *
 * A single cursor walks every column — four stages, then the three panels
 * holding what the dispatcher needs a person to answer. Keys run the command
 * that the selected row and column allow; a key whose action a row cannot take
 * is simply ignored.
 */
export const Pipeline = (props: {
  readonly state: Accessor<FleetState>;
  readonly controls: Controls;
}) => {
  const [column, setColumn] = createSignal<ColumnName>("focus");
  const [row, setRow] = createSignal(0);

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

  const moveColumn = (delta: number) => {
    const index = COLUMNS.indexOf(column());
    const next = COLUMNS[(index + delta + COLUMNS.length) % COLUMNS.length];
    if (next) {
      setColumn(next);
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
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <Column
          title="focus"
          rows={() => rowsFor("focus", props.state())}
          selected={selectedFor("focus")}
        />
        <Column
          title="queue"
          rows={() => rowsFor("queue", props.state())}
          selected={selectedFor("queue")}
        />
        <Column
          title="working"
          rows={() => rowsFor("working", props.state())}
          selected={selectedFor("working")}
        />
        <Column
          title="review"
          rows={() => rowsFor("review", props.state())}
          selected={selectedFor("review")}
        />
        <Column
          title="landed"
          rows={() => rowsFor("landed", props.state())}
          selected={selectedFor("landed")}
        />
      </box>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <Column
          title="decisions"
          rows={() => rowsFor("decisions", props.state())}
          selected={selectedFor("decisions")}
        />
        <Column
          title="yours"
          rows={() => rowsFor("yours", props.state())}
          selected={selectedFor("yours")}
        />
        <Column
          title="held"
          rows={() => rowsFor("held", props.state())}
          selected={selectedFor("held")}
        />
        <Column
          title="stranded"
          rows={() => rowsFor("stranded", props.state())}
          selected={selectedFor("stranded")}
        />
      </box>
      <Status state={props.state} />
    </box>
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
                attributes:
                  index() === props.selected() ? createTextAttributes({ inverse: true }) : 0,
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

/** Renderable ids are global, so a row's key is only unique within its column. */
const rowId = (column: string, key: string): string => `${column}:${key}`;

/**
 * Why the pipeline is not moving, when it is not moving, and what to press.
 *
 * Held projects are named because a queue that stops for a reason nobody can
 * see reads as a broken dispatcher, and the reason — the operator's own
 * uncommitted work — is one only they can clear.
 */
const Status = (props: { readonly state: Accessor<FleetState> }) => (
  <box style={{ flexDirection: "column", flexShrink: 0 }}>
    <text style={{ height: 1 }}>
      {props.state().held.length === 0 ? "" : `held: ${props.state().held.join(", ")}`}
    </text>
    <text style={{ height: 1 }}>
      {props.state().focused
        ? `focus: ${props.state().focus.length} ready · ${props.state().paused ? "paused" : "running"}`
        : `${props.state().paused ? "paused" : "running"}`}
      {`  ·  ${props.state().decisions.length} awaiting a decision`}
    </text>
    <text style={{ height: 1 }}>
      {"r retry  t take over  f focus  e climb  d release  c close  o onboard  s send for review"}
    </text>
    <text style={{ height: 1 }}>{"p pause  F12 log  q quit"}</text>
  </box>
);

const rowsFor = (column: ColumnName, state: FleetState): ReadonlyArray<ColumnRow> => {
  switch (column) {
    case "focus":
      return state.focus.map(readyRow);
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
