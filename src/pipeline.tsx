import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { DateTime } from "effect";
import { createEffect, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import type { Active, Climbing, FleetState, InterventionTarget, Orphan } from "./dispatcher.ts";
import type { Worker } from "./fleet.ts";
import {
  diagnosticIntent,
  reviewedBy,
  rungOf,
  type DiagnosticIntent,
  type Item,
  type ReadyTask,
} from "./prog.ts";

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
  readonly descend: (task: Climbing) => void;
  readonly unassign: (task: Climbing) => void;
  readonly onboard: (project: string) => void;
  readonly adopt: (orphan: Orphan) => void;
  readonly complete: (task: ReadyTask, reason: string) => void;
  readonly diagnose: (target: InterventionTarget, intent: DiagnosticIntent, rung: string) => void;
  readonly reviewIntervention: (
    target: InterventionTarget,
    diagnosticRung: string | undefined,
  ) => void;
  readonly continueAt: (target: InterventionTarget, rung: string) => void;
}

const COLUMNS = [
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
const VIEWS = ["queue", "working", "review", "landed", "attention"] as const;
type ViewName = (typeof VIEWS)[number];
const PAGE_STEP = 5;
const DETAIL_BREAKPOINT = 120;

/**
 * The non-empty views, which are the only tabs drawn.
 *
 * An empty box is a claim on the screen that pays nothing back: the count in
 * its title is already zero, and a fleet with nothing held, nothing stranded
 * and no decision waiting is the ordinary case rather than news. Drawing them
 * anyway costs the columns that do hold work the width they need to show a
 * title. Nothing is reachable that is not drawn, so the cursor and keys follow
 * this too.
 */
const drawn = (state: FleetState): ReadonlyArray<ViewName> =>
  VIEWS.filter((name) => rowsForView(name, state).length > 0);

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
  readonly column: ColumnName;
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
  readonly hasWork: boolean;
  readonly committed: boolean;
}

type Action =
  | "complete"
  | "retry"
  | "release"
  | "close"
  | "takeOver"
  | "focus"
  | "intervene"
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
  queue: ["complete", "intervene", "descend", "unassign"],
  working: ["focus", "intervene", "descend", "release"],
  review: ["focus", "intervene", "descend", "release"],
  landed: [],
  decisions: ["retry", "takeOver", "intervene", "release", "close", "unassign"],
  yours: ["intervene", "descend", "unassign"],
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
  "author vanished": ["retry", "takeOver", "intervene", "release"],
  "reviewer vanished": ["retry", "takeOver", "intervene", "release"],
  "orphaned workspace": ["intervene", "close", "unassign"],
};

const ACTION_LABELS: Record<Action, string> = {
  complete: "D done",
  retry: "r retry",
  takeOver: "t take over",
  focus: "f focus",
  intervene: "e intervene",
  descend: "x descend",
  unassign: "u unassign",
  release: "d release",
  close: "c close",
  onboard: "o onboard",
  adopt: "s adopt",
};

/** The commands that are meaningful for this exact row, not just its column. */
const actionsFor = (column: ColumnName, row: ColumnRow | undefined): ReadonlyArray<Action> => {
  if (!row) return [];
  const actions =
    column === "decisions" && row.task ? DECISION_ACTIONS[decisionKind(row.task)] : ACTIONS[column];

  return actions.filter((action) => {
    switch (action) {
      case "takeOver":
      case "focus":
        return row.worker !== undefined;
      case "descend":
        return (
          (row.task !== undefined && rungOf(row.task) !== undefined) ||
          (row.ready !== undefined && rungOf(row.ready) !== undefined)
        );
      case "unassign":
        return (
          (row.task !== undefined && staleReview(row.task, row.worker)) ||
          (row.ready !== undefined && staleReview(row.ready, undefined))
        );
      case "retry":
      case "release":
      case "close":
        return row.task !== undefined;
      case "complete":
        return row.ready !== undefined;
      case "intervene":
        return (
          row.ready !== undefined ||
          (row.task !== undefined && row.task.status !== "done" && row.task.status !== "canceled")
        );
      case "onboard":
        return row.project !== undefined;
      case "adopt":
        return row.orphan !== undefined;
    }
  });
};

/**
 * The pipeline, drawn from whatever the dispatcher last observed.
 *
 * A single cursor walks one list at a time. Non-empty views become tabs; all
 * exceptional states share an attention view so ordinary work keeps the width
 * needed to remain readable in a small pane.
 */
export const Pipeline = (props: {
  readonly state: Accessor<FleetState>;
  readonly controls: Controls;
  readonly rungs: ReadonlyArray<string>;
}) => {
  const dimensions = useTerminalDimensions();
  const [wanted, setWanted] = createSignal<ViewName>("queue");
  const [row, setRow] = createSignal(0);
  const [completion, setCompletion] = createSignal<ReadyTask | undefined>();
  const [intervention, setIntervention] = createSignal<ColumnRow | undefined>();
  const [rungChoice, setRungChoice] = createSignal<{
    readonly action: "diagnose" | "review" | "continue";
    readonly index: number;
  }>();

  const views = (): ReadonlyArray<ViewName> => drawn(props.state());

  let hadAttention = false;
  createEffect(() => {
    const hasAttention = rowsForView("attention", props.state()).length > 0;
    if (hasAttention && !hadAttention) {
      setWanted("attention");
      setRow(0);
    }
    hadAttention = hasAttention;
  });

  // A view that empties under the cursor goes. Keep the cursor as near as
  // possible to where it was in the stable tab order.
  const view = (): ViewName => {
    const here = views();
    if (here.includes(wanted())) return wanted();
    const index = VIEWS.indexOf(wanted());
    return here.filter((name) => VIEWS.indexOf(name) < index).at(-1) ?? here[0] ?? wanted();
  };

  const rows = (): ReadonlyArray<ColumnRow> => rowsForView(view(), props.state());

  // The cursor clamps to the view it sits in: a shrinking list never
  // strands the selection past its last row.
  const selected = (): number | undefined => {
    const count = rows().length;
    if (count === 0) return undefined;
    return Math.min(row(), count - 1);
  };

  const step = (delta: number) => {
    const count = rows().length;
    if (count === 0) return;
    setRow((current) => Math.min(Math.max(current + delta, 0), count - 1));
  };

  const selectRow = (index: number) => {
    setRow(index);
  };

  const targetOf = (target: ColumnRow): InterventionTarget | undefined => {
    const task = target.task ?? target.ready;
    return task ? { task, worker: target.worker } : undefined;
  };

  const chooseRung = (action: "diagnose" | "review" | "continue") => {
    const target = intervention();
    if (!target || props.rungs.length === 0) return;
    const current = rungOf(target.task ?? target.ready ?? { labels: [] });
    const index = Math.max(props.rungs.indexOf(current ?? ""), 0);
    setRungChoice({ action, index });
  };

  const moveView = (delta: number) => {
    const visible = views();
    const index = visible.indexOf(view());
    const next = visible[(index + delta + visible.length) % visible.length];
    if (next) {
      setWanted(next);
      setRow(0);
    }
  };

  const apply = (action: Action) => {
    const index = selected();
    if (index === undefined) return;
    const target = rows()[index];
    if (!target) return;
    if (!actionsFor(target.column, target).includes(action)) return;
    switch (action) {
      case "complete":
        if (target.ready) {
          // Do not let the key that opens the input become its first character.
          queueMicrotask(() => setCompletion(target.ready));
        }
        break;
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
        if (target.worker) props.controls.focus(target.worker);
        break;
      case "focus":
        if (target.worker) props.controls.focus(target.worker);
        break;
      case "intervene":
        setIntervention(target);
        break;
      case "descend":
        if (target.task && rungOf(target.task) !== undefined) props.controls.descend(target.task);
        else if (target.ready && rungOf(target.ready) !== undefined)
          props.controls.descend(target.ready);
        break;
      case "unassign":
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
    if (completion() !== undefined) {
      if (key.name === "escape") setCompletion(undefined);
      return;
    }
    const choosing = rungChoice();
    if (choosing) {
      if (key.name === "escape") {
        setRungChoice(undefined);
        setIntervention(undefined);
      } else if (key.name === "up" || key.name === "k") {
        setRungChoice({ ...choosing, index: Math.max(choosing.index - 1, 0) });
      } else if (key.name === "down" || key.name === "j") {
        setRungChoice({
          ...choosing,
          index: Math.min(choosing.index + 1, props.rungs.length - 1),
        });
      } else if (key.name === "return") {
        const row = intervention();
        const target = row ? targetOf(row) : undefined;
        const rung = props.rungs[choosing.index];
        if (target && rung) {
          if (choosing.action === "continue") props.controls.continueAt(target, rung);
          else if (choosing.action === "diagnose")
            props.controls.diagnose(target, "diagnose", rung);
          else props.controls.reviewIntervention(target, rung);
        }
        setRungChoice(undefined);
        setIntervention(undefined);
      }
      return;
    }
    const intervening = intervention();
    if (intervening) {
      if (key.name === "escape") setIntervention(undefined);
      else if (key.name === "d" && intervening.hasWork) chooseRung("diagnose");
      else if (key.name === "r" && intervening.committed) {
        const target = targetOf(intervening);
        if (target) props.controls.reviewIntervention(target, undefined);
        setIntervention(undefined);
      } else if (key.name === "r" && intervening.hasWork) chooseRung("review");
      else if (key.name === "c") chooseRung("continue");
      return;
    }
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
      case "pageup":
        step(-PAGE_STEP);
        break;
      case "pagedown":
        step(PAGE_STEP);
        break;
      case "left":
      case "h":
        moveView(-1);
        break;
      case "right":
      case "l":
        moveView(1);
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
        apply("intervene");
        break;
      case "x":
        apply("descend");
        break;
      case "u":
        apply("unassign");
        break;
      case "d":
        apply(key.shift ? "complete" : "release");
        break;
      case "D":
        apply("complete");
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
      <Tabs
        views={views}
        selected={view}
        state={props.state}
        select={(name) => {
          setWanted(name);
          setRow(0);
        }}
      />
      <box style={{ flexDirection: "row", flexGrow: 1, minHeight: 0 }}>
        <Show when={rows().length > 0}>
          <TaskList view={view} rows={rows} selected={selected} scroll={step} select={selectRow} />
          <Show when={dimensions().width >= DETAIL_BREAKPOINT}>
            <Details row={() => rows()[selected() ?? -1]} />
          </Show>
        </Show>
      </box>
      <Status
        state={props.state}
        actions={() => {
          const target = rows()[selected() ?? -1];
          return target ? actionsFor(target.column, target) : [];
        }}
        completion={completion}
        intervention={intervention}
        rungChoice={rungChoice}
        rungs={props.rungs}
        complete={(reason) => {
          const task = completion();
          const trimmed = reason.trim();
          if (!task || trimmed.length === 0) return;
          props.controls.complete(task, trimmed);
          setCompletion(undefined);
        }}
        cancel={() => setCompletion(undefined)}
      />
    </box>
  );
};

const Tabs = (props: {
  readonly views: Accessor<ReadonlyArray<ViewName>>;
  readonly selected: Accessor<ViewName>;
  readonly state: Accessor<FleetState>;
  readonly select: (name: ViewName) => void;
}) => (
  <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
    <For each={props.views()}>
      {(name) => (
        <text
          style={props.selected() === name ? SELECTED : TAB}
          onMouseDown={() => props.select(name)}
        >
          {` ${viewLabel(name)} ${rowsForView(name, props.state()).length} `}
        </text>
      )}
    </For>
  </box>
);

/** One full-height list. The cursor remains the only scroll position. */
const TaskList = (props: {
  readonly view: Accessor<ViewName>;
  readonly rows: Accessor<ReadonlyArray<ColumnRow>>;
  readonly selected: Accessor<number | undefined>;
  readonly scroll: (delta: number) => void;
  readonly select: (index: number) => void;
}) => {
  let viewport: ScrollBoxRenderable | undefined;

  // The cursor is what scrolls the list; there is no separate scroll
  // position to get out of step with it. Selecting past the fold brings the
  // row up, so j and k never walk the selection off the screen.
  createEffect(() => {
    const index = props.selected();
    const row = index === undefined ? undefined : props.rows()[index];
    if (row) viewport?.scrollChildIntoView(rowId(props.view(), row.key));
  });

  return (
    <box
      style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, minWidth: 0, border: true }}
      borderColor={ACTIVE_BORDER}
      title={`${viewLabel(props.view())} ${(props.selected() ?? 0) + 1}/${props.rows().length}`}
    >
      <scrollbox
        ref={(element) => (viewport = element)}
        style={{ flexGrow: 1, minWidth: 0, rootOptions: { flexGrow: 1, minWidth: 0 } }}
        scrollX={false}
        contentOptions={{ onMouseScroll: wheel(props.scroll) }}
      >
        <For each={props.rows()}>
          {(row, index) => (
            <text
              id={rowId(props.view(), row.key)}
              style={{
                height: 1,
                flexShrink: 0,
                ...(index() === props.selected() ? SELECTED : PLAIN),
              }}
              truncate
              onMouseDown={() => props.select(index())}
            >
              {`${index() === props.selected() ? "> " : "  "}${row.label}`}
            </text>
          )}
        </For>
      </scrollbox>
    </box>
  );
};

const Details = (props: { readonly row: Accessor<ColumnRow | undefined> }) => (
  <box
    title="selection"
    border
    borderColor={INACTIVE_BORDER}
    style={{ flexDirection: "column", width: "38%", flexShrink: 0, paddingX: 1 }}
  >
    <Show when={props.row()}>
      {(row: Accessor<ColumnRow>) => (
        <>
          <text fg="#60a5fa">{row().key}</text>
          <text>{row().label}</text>
          <text>{`view      ${viewLabel(sourceView(row().column))}`}</text>
          <Show when={row().task}>
            {(task: Accessor<Item>) => (
              <>
                <text>{`status    ${task().status}`}</text>
                <text>{`project   ${task().project}`}</text>
                <text>{`priority  ${task().priority}`}</text>
                <text>{`labels    ${task().labels.join(", ") || "none"}`}</text>
              </>
            )}
          </Show>
          <Show when={row().ready}>
            {(task: Accessor<ReadyTask>) => (
              <>
                <text>status ready</text>
                <text>{`project   ${task().project}`}</text>
                <text>{`priority  ${task().priority}`}</text>
                <text>{`labels    ${task().labels.join(", ") || "none"}`}</text>
              </>
            )}
          </Show>
          <Show when={row().worker}>
            {(worker: Accessor<Worker>) => <text>{`worker    ${worker().state}`}</text>}
          </Show>
          <Show when={row().project && !row().task && !row().ready}>
            <text>{`project   ${row().project}`}</text>
          </Show>
          <Show when={row().orphan}>
            {(orphan: Accessor<Orphan>) => <text>{`project   ${orphan().project}`}</text>}
          </Show>
        </>
      )}
    </Show>
  </box>
);

/**
 * A wheel notch, turned into one step of the cursor.
 *
 * The listener sits on the scrollbox's content rather than on the scrollbox,
 * and that placement is the whole trick. A mouse event runs a renderable's own
 * listeners, then its built-in handler, then walks to its parent — so
 * `stopPropagation` only stops the walk, and a listener on the scrollbox could
 * never suppress the scrollbox's own scrolling. From the content, the scrollbox
 * is the parent that is never reached.
 *
 * A notch is always a delta of one, so there is nothing to scale; only the
 * direction is read, and a sideways wheel is ignored because a column scrolls
 * in one axis.
 */
const wheel =
  (scroll: (delta: number) => void) =>
  (event: MouseEvent): void => {
    const direction = event.scroll?.direction;
    if (direction !== "up" && direction !== "down") return;
    event.stopPropagation();
    scroll(direction === "up" ? -1 : 1);
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
const TAB = { bg: "transparent", fg: "#94a3b8" } as const;

/**
 * Those same defaults, named so that leaving a row restores them.
 *
 * A style key that is simply absent is not a style key set back: the renderable
 * keeps whatever it was last given, so the highlight stayed on the row the
 * cursor had left until the next tick rebuilt the rows. Both states have to
 * name both colours.
 */
const PLAIN = { bg: "transparent", fg: "#FFFFFF" } as const;
const ACTIVE_BORDER = "#60a5fa";
const INACTIVE_BORDER = "#334155";

/** Renderable ids are global, so a row's key is only unique within its column. */
const rowId = (column: string, key: string): string => `${column}:${key}`;

const viewLabel = (view: ViewName): string =>
  view === "attention" ? "Attention" : `${view[0]?.toUpperCase()}${view.slice(1)}`;

const sourceView = (column: ColumnName): ViewName =>
  column === "decisions" || column === "yours" || column === "held" || column === "stranded"
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
 * Whether the pipeline is moving, and what to press.
 *
 * This is the one thing always on screen: with every column empty the fleet
 * still has to say whether it is paused or simply out of work.
 */
const Status = (props: {
  readonly state: Accessor<FleetState>;
  readonly actions: Accessor<ReadonlyArray<Action>>;
  readonly completion: Accessor<ReadyTask | undefined>;
  readonly intervention: Accessor<ColumnRow | undefined>;
  readonly rungChoice: Accessor<
    { readonly action: "diagnose" | "review" | "continue"; readonly index: number } | undefined
  >;
  readonly rungs: ReadonlyArray<string>;
  readonly complete: (reason: string) => void;
  readonly cancel: () => void;
}) => {
  // The age has to advance on its own clock. A tick publishes its reading and
  // then works, and nothing republishes while it works — so an age derived from
  // state alone would sit frozen at the very moment it is worth reading.
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(clock));

  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <text style={{ height: 1 }}>
        {`${props.state().paused ? "paused" : "running"}  ·  ${readAge(props.state(), now())}  ·  ${attentionStatus(props.state())}`}
      </text>
      <Show
        when={props.rungChoice() === undefined}
        fallback={
          <text style={{ height: 1 }}>
            {`${props.rungChoice()?.action} rung  ${props.rungs.map((rung, index) => (index === props.rungChoice()?.index ? `[${rung}]` : rung)).join("  ")}  j/k choose  Enter confirm  Esc cancel`}
          </text>
        }
      >
        <Show
          when={props.intervention() === undefined}
          fallback={
            <text style={{ height: 1 }}>
              {[
                props.intervention()?.hasWork ? "d diagnose" : undefined,
                props.intervention()?.hasWork ? "r review" : undefined,
                "c continue",
                "Esc cancel",
              ]
                .filter((label) => label !== undefined)
                .join("  ")}
            </text>
          }
        >
          <Show
            when={props.completion() === undefined}
            fallback={
              <box style={{ flexDirection: "row", height: 1 }}>
                <text>{`Reason for ${props.completion()?.id}: `}</text>
                <input
                  focused
                  flexGrow={1}
                  placeholder="required"
                  onSubmit={props.complete as never}
                  onKeyDown={(key) => {
                    if (key.name === "escape") props.cancel();
                  }}
                />
                <text> Enter confirm Esc cancel</text>
              </box>
            }
          >
            <text style={{ height: 1 }}>
              {[
                ...props.actions().map((action) => ACTION_LABELS[action]),
                "h/l view",
                "j/k move",
                `p ${props.state().paused ? "resume" : "pause"}`,
                "F12 log",
                "q quit",
              ].join("  ")}
            </text>
          </Show>
        </Show>
      </Show>
    </box>
  );
};

const rowsFor = (column: ColumnName, state: FleetState): ReadonlyArray<ColumnRow> => {
  switch (column) {
    case "queue":
      return state.queue.map((task) => readyRow(task, "queue", state));
    case "working":
      return state.working.map((active) => activeRow(active, "working", state));
    case "review":
      return state.review.map((active) => activeRow(active, "review", state));
    case "landed":
      return state.landed.map((task) => landedRow(task, state));
    case "decisions":
      return state.decisions.map((active) => decisionRow(active, state));
    case "yours":
      return state.yours.map((task) => readyRow(task, "yours", state));
    case "held":
      return state.held.map(heldRow);
    case "stranded":
      return state.orphans.map(orphanRow);
  }
};

const rowsForView = (view: ViewName, state: FleetState): ReadonlyArray<ColumnRow> => {
  if (view !== "attention") return rowsFor(view, state);
  return [
    ...rowsFor("decisions", state),
    ...rowsFor("yours", state).map(attentionRow("needs you")),
    ...rowsFor("stranded", state).map(attentionRow("stranded")),
    ...rowsFor("held", state).map(attentionRow("held")),
  ];
};

const attentionRow =
  (kind: string) =>
  (row: ColumnRow): ColumnRow => ({ ...row, label: `${kind}  ${row.label}` });

const readyRow = (task: ReadyTask, column: "queue" | "yours", state: FleetState): ColumnRow => ({
  column,
  key: task.id,
  label: `${task.project}  ${task.title}`,
  task: undefined,
  ready: task,
  worker: undefined,
  project: undefined,
  orphan: undefined,
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
  task,
  ready: undefined,
  worker,
  project: undefined,
  orphan: undefined,
  hasWork: worker !== undefined || state.resumable.has(task.id),
  committed: state.committed.has(task.id),
});

const landedRow = (task: Item, state: FleetState): ColumnRow => ({
  column: "landed",
  key: task.id,
  label: `${task.project}  ${task.title}`,
  task,
  ready: undefined,
  worker: undefined,
  project: undefined,
  orphan: undefined,
  hasWork: state.resumable.has(task.id),
  committed: state.committed.has(task.id),
});

const decisionRow = ({ task, worker, kind }: Active, state: FleetState): ColumnRow => ({
  column: "decisions",
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
  hasWork: worker !== undefined || state.resumable.has(task.id),
  committed: state.committed.has(task.id),
});

const heldRow = (project: string): ColumnRow => ({
  column: "held",
  key: project,
  label: project,
  task: undefined,
  ready: undefined,
  worker: undefined,
  project,
  orphan: undefined,
  hasWork: false,
  committed: false,
});

// A branch whose task is gone has no id to dispatch against, so the row says
// so rather than offering a key that would do nothing.
const orphanRow = (orphan: Orphan): ColumnRow => ({
  column: "stranded",
  key: orphan.branch,
  label: `${orphan.branch}  ${orphan.title ?? "task deleted — recover by hand"}`,
  task: undefined,
  ready: undefined,
  worker: undefined,
  project: undefined,
  orphan,
  hasWork: true,
  committed: true,
});
