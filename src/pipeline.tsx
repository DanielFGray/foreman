import { createTextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createSignal, For, type Accessor } from "solid-js";
import type { Active, FleetState } from "./dispatcher.ts";
import type { Worker } from "./fleet.ts";
import { authoredBy, reviewedBy, type Item, type ReadyTask } from "./prog.ts";

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
  readonly escalate: (task: { readonly id: string }) => void;
  readonly onboard: (project: string) => void;
}

/** The six selectable stages, in the order the cursor moves through them. */
const COLUMNS = ["queue", "working", "review", "landed", "decisions", "held"] as const;
type ColumnName = (typeof COLUMNS)[number];

export type DecisionKind = "author vanished" | "reviewer vanished" | "orphaned workspace";

/**
 * Which role stopped, from the task's labels alone.
 *
 * A reviewer-vanished task also carries its author label, so the reviewer
 * check comes first: `reviewing` plus `review-by-*` is the dispatcher's own
 * definition of the reviewer having been dispatched. A task with neither
 * label in the decisions column can only be a workspace left behind by
 * something that never claimed its task.
 */
export const decisionKind = (task: Item): DecisionKind =>
  reviewedBy(task) !== undefined
    ? "reviewer vanished"
    : authoredBy(task) !== undefined
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
}

type Action = "retry" | "release" | "takeOver" | "focus" | "escalate" | "onboard";

/**
 * Which keys mean something in which column.
 *
 * Landed is history and takes no action; a queue task is only ever escalated,
 * because releasing a task that was never claimed has nothing to undo. The
 * same key does not change meaning between columns.
 */
const ACTIONS: Record<ColumnName, ReadonlyArray<Action>> = {
  queue: ["escalate"],
  working: ["focus", "escalate", "release"],
  review: ["focus", "escalate", "release"],
  landed: [],
  decisions: ["retry", "takeOver", "release"],
  held: ["onboard"],
};

/**
 * The pipeline, drawn from whatever the dispatcher last observed.
 *
 * A single cursor walks every column — four stages, then the two panels the
 * dispatcher needs answered. Keys run the command that the selected row and
 * column allow; a key whose action a row cannot take is simply ignored.
 */
export const Pipeline = (props: {
  readonly state: Accessor<FleetState>;
  readonly controls: Controls;
}) => {
  const [column, setColumn] = createSignal<ColumnName>("queue");
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
    switch (action) {
      case "retry":
        if (target.task) props.controls.retry(target.task);
        break;
      case "release":
        if (target.task) props.controls.release(target.task);
        break;
      case "takeOver":
        // A vanished worker can still be taken over when its workspace
        // exists; a decision with no workspace is retry or release only.
        if (target.worker) props.controls.focus(target.worker);
        break;
      case "focus":
        if (target.worker) props.controls.focus(target.worker);
        break;
      case "escalate":
        if (target.task) props.controls.escalate(target.task);
        else if (target.ready) props.controls.escalate(target.ready);
        break;
      case "onboard":
        if (target.project) props.controls.onboard(target.project);
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
        apply("escalate");
        break;
      case "d":
        apply("release");
        break;
      case "o":
        apply("onboard");
        break;
    }
  });

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
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
          title="held"
          rows={() => rowsFor("held", props.state())}
          selected={selectedFor("held")}
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
 */
const Column = (props: {
  readonly title: string;
  readonly rows: Accessor<ReadonlyArray<ColumnRow>>;
  readonly selected: Accessor<number | undefined>;
}) => (
  <box
    style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, minWidth: 0, border: true }}
    title={`${props.title} ${props.rows().length}`}
  >
    <For each={props.rows()}>
      {(row, index) => (
        <text
          style={{
            height: 1,
            flexShrink: 0,
            attributes: index() === props.selected() ? createTextAttributes({ inverse: true }) : 0,
          }}
        >
          {`${index() === props.selected() ? "> " : "  "}${row.label}`}
        </text>
      )}
    </For>
  </box>
);

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
      {`${props.state().paused ? "paused" : "running"}  ·  ${props.state().decisions.length} awaiting a decision`}
    </text>
    <text style={{ height: 1 }}>
      {"r retry  t take over  f focus  e escalate  d release  o onboard"}
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
    case "held":
      return state.held.map(heldRow);
  }
};

const readyRow = (task: ReadyTask): ColumnRow => ({
  key: task.id,
  label: `${task.project}  ${task.title}`,
  task: undefined,
  ready: task,
  worker: undefined,
  project: undefined,
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
});

const landedRow = (task: Item): ColumnRow => ({
  key: task.id,
  label: `${task.project}  ${task.title}`,
  task,
  ready: undefined,
  worker: undefined,
  project: undefined,
});

const decisionRow = ({ task, worker, kind }: Active): ColumnRow => ({
  key: task.id,
  label: `${task.id}  ${kind ?? "?"} — ${decisionKind(task)}`,
  task,
  ready: undefined,
  worker,
  project: undefined,
});

const heldRow = (project: string): ColumnRow => ({
  key: project,
  label: project,
  task: undefined,
  ready: undefined,
  worker: undefined,
  project,
});
