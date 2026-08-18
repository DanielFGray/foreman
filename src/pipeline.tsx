import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { DateTime, Match } from "effect";
import { createEffect, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import {
  nextDispatch,
  type Active,
  type Climbing,
  type FleetState,
  type Held,
  type InterventionTarget,
  type Unreviewed,
} from "./dispatcher.ts";
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
  readonly cycleDispatch: () => void;
  readonly toggleConsole: () => void;
  readonly focus: (worker: Worker) => void;
  readonly retry: (task: Item) => void;
  readonly release: (task: Item) => void;
  readonly close: (task: Item) => void;
  readonly descend: (task: Climbing) => void;
  readonly unassign: (task: Climbing) => void;
  readonly onboard: (project: string) => void;
  readonly adopt: (branch: Unreviewed) => void;
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
  "unreviewed",
] as const;
type ColumnName = (typeof COLUMNS)[number];
const VIEWS = ["queue", "working", "review", "landed", "attention"] as const;
type ViewName = (typeof VIEWS)[number];

/**
 * The views the cursor follows a tracked task through.
 *
 * A task climbs queue → working → review and the highlight chases it, and a
 * task parked at the operator or needing a decision is still live work, so
 * attention is followed too. Landed is not: a task that landed is finished,
 * and chasing it into history only walks the operator out of the work still to
 * do. Landing ends the follow, and the cursor falls back where it was.
 */
const FOLLOW_VIEWS = ["queue", "working", "review", "attention"] as const;

const PAGE_STEP = 5;
const DETAIL_BREAKPOINT = 120;

/**
 * The non-empty views, which are the only tabs drawn.
 *
 * An empty box is a claim on the screen that pays nothing back: the count in
 * its title is already zero, and a fleet with nothing held, nothing unread
 * and no decision waiting is the ordinary case rather than news. Drawing them
 * anyway costs the columns that do hold work the width they need to show a
 * title. Nothing is reachable that is not drawn, so the cursor and keys follow
 * this too.
 */
const drawn = (state: FleetState): ReadonlyArray<ViewName> =>
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
  /** The hold's reason, for rows whose actions depend on what is holding it. */
  readonly reason: Held["reason"] | undefined;
  /** The branch behind an unreviewed row, whose commits nothing is reading. */
  readonly unreviewed: Unreviewed | undefined;
  /** The error behind a dispatch-failed decision row. */
  readonly failure: string | undefined;
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
  unreviewed: ["adopt"],
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
    column === "decisions" && row.task
      ? DECISION_ACTIONS[decisionKind(row.task, row.failure)]
      : ACTIONS[column];

  return actions.filter((action) =>
    Match.value(action).pipe(
      Match.when("takeOver", () => row.worker !== undefined),
      Match.when("focus", () => row.worker !== undefined),
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
      Match.when("close", () => row.task !== undefined),
      Match.when("complete", () => row.ready !== undefined),
      Match.when(
        "intervene",
        () =>
          row.ready !== undefined ||
          (row.task !== undefined && row.task.status !== "done" && row.task.status !== "canceled"),
      ),
      // Onboarding salvages uncommitted work, so it is only offered for a hold that
      // is uncommitted work. A checkout with no branch has nothing to salvage: a
      // hand-run command is the fix, and offering a top-rung run that finds an empty
      // tree would spend it on nothing.
      Match.when("onboard", () => row.project !== undefined && row.reason === "dirty"),
      Match.when("adopt", () => row.unreviewed !== undefined),
      Match.exhaustive,
    ),
  );
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

  /**
   * The cursor, one signal because every key rewrites all three parts together.
   *
   * `key` is the tracked row, by id rather than by position, so a tick that
   * reorders rows or moves the task to another column does not swap the row out
   * from under the operator. `index` is only a fallback anchor: the key's last
   * position in the current view, kept so a vanished task gives up its cursor
   * to the nearest surviving row instead of to the front of the list. `view` is
   * where the operator is looking, and the follow keeps it on the tracked key.
   */
  const [cursor, setCursor] = createSignal<{
    readonly view: ViewName;
    readonly key: string | undefined;
    readonly index: number;
  }>({ view: "queue", key: undefined, index: 0 });
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
    if (hasAttention && !hadAttention) select("attention");
    hadAttention = hasAttention;
  });

  /**
   * Keeps the cursor consistent with the world after every tick.
   *
   * The view resolves to where the tracked key is, unless it has left the
   * followed views entirely. A key in both the current view and attention — a
   * vanished worker's task sits in working and decisions at once — stays where
   * the operator is, so the follow never fights a deliberate placement. When
   * the key is present, its position becomes the anchor; when it is gone, the
   * anchor is clamped and the key rebases onto that surviving row.
   */
  createEffect(() => {
    const current = view();
    const cur = cursor();
    const inCurrent =
      cur.key !== undefined &&
      rowsForView(current, props.state()).some((row) => row.key === cur.key);
    const followed =
      cur.key === undefined
        ? undefined
        : inCurrent
          ? current
          : FOLLOW_VIEWS.find(
              (name) =>
                views().includes(name) &&
                rowsForView(name, props.state()).some((row) => row.key === cur.key),
            );
    const target = followed ?? current;
    const rows = rowsForView(target, props.state());
    if (rows.length === 0) {
      if (target !== cur.view || cur.key !== undefined || cur.index !== 0)
        setCursor({ view: target, key: undefined, index: 0 });
      return;
    }
    const at = rows.findIndex((row) => row.key === cur.key);
    if (at !== -1) {
      if (target !== cur.view || at !== cur.index)
        setCursor({ view: target, key: cur.key, index: at });
    } else {
      const index = Math.min(cur.index, rows.length - 1);
      const row = rows[index];
      if (row && (target !== cur.view || index !== cur.index || row.key !== cur.key))
        setCursor({ view: target, key: row.key, index });
    }
  });

  // A view that empties under the cursor goes. Keep the cursor as near as
  // possible to where it was in the stable tab order.
  const view = (): ViewName => {
    const here = views();
    if (here.includes(cursor().view)) return cursor().view;
    const index = VIEWS.indexOf(cursor().view);
    return here.filter((name) => VIEWS.indexOf(name) < index).at(-1) ?? here[0] ?? cursor().view;
  };

  const rows = (): ReadonlyArray<ColumnRow> => rowsForView(view(), props.state());

  // The cursor is the key, not a position: a shrinking list never strands it
  // past the last row, and the row is whoever the key names rather than
  // whatever a reshuffle left at this spot.
  const selected = (): number | undefined => {
    const here = rows();
    if (here.length === 0) return undefined;
    const at = here.findIndex((row) => row.key === cursor().key);
    return at !== -1 ? at : Math.min(cursor().index, here.length - 1);
  };

  const step = (delta: number) => {
    const here = rows();
    if (here.length === 0) return;
    const at = here.findIndex((row) => row.key === cursor().key);
    const base = at !== -1 ? at : cursor().index;
    const index = Math.min(Math.max(base + delta, 0), here.length - 1);
    const row = here[index];
    if (row) setCursor({ view: view(), key: row.key, index });
  };

  const selectRow = (index: number) => {
    const row = rows()[index];
    if (row) setCursor({ view: view(), key: row.key, index });
  };

  /** Moves the cursor into a view, keeping the tracked key when it is there. */
  const select = (view: ViewName) => {
    const here = rowsForView(view, props.state());
    const at = here.findIndex((row) => row.key === cursor().key);
    const first = here[0];
    const next =
      at !== -1
        ? { view, key: cursor().key, index: at }
        : first !== undefined
          ? { view, key: first.key, index: 0 }
          : { view, key: undefined, index: 0 };
    const cur = cursor();
    if (next.view !== cur.view || next.key !== cur.key || next.index !== cur.index) setCursor(next);
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
    if (next) select(next);
  };

  const apply = (action: Action) => {
    const index = selected();
    if (index === undefined) return;
    const target = rows()[index];
    if (!target) return;
    if (!actionsFor(target.column, target).includes(action)) return;
    Match.value(action).pipe(
      Match.when("complete", () => {
        if (target.ready) {
          // Do not let the key that opens the input become its first character.
          queueMicrotask(() => setCompletion(target.ready));
        }
      }),
      Match.when("retry", () => target.task && props.controls.retry(target.task)),
      Match.when("release", () => target.task && props.controls.release(target.task)),
      Match.when("close", () => target.task && props.controls.close(target.task)),
      Match.when("takeOver", () => target.worker && props.controls.focus(target.worker)),
      Match.when("focus", () => target.worker && props.controls.focus(target.worker)),
      Match.when("intervene", () => setIntervention(target)),
      Match.when("descend", () => {
        if (target.task && rungOf(target.task) !== undefined) props.controls.descend(target.task);
        else if (target.ready && rungOf(target.ready) !== undefined)
          props.controls.descend(target.ready);
      }),
      Match.when("unassign", () => {
        if (target.task && staleReview(target.task, target.worker))
          props.controls.unassign(target.task);
        else if (target.ready && staleReview(target.ready, undefined))
          props.controls.unassign(target.ready);
      }),
      Match.when("onboard", () => target.project && props.controls.onboard(target.project)),
      Match.when("adopt", () => target.unreviewed && props.controls.adopt(target.unreviewed)),
      Match.exhaustive,
    );
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
    const keyboardActions: Record<string, () => void> = {
      q: props.controls.quit,
      p: props.controls.cycleDispatch,
      f12: props.controls.toggleConsole,
      up: () => step(-1),
      k: () => step(-1),
      down: () => step(1),
      j: () => step(1),
      pageup: () => step(-PAGE_STEP),
      pagedown: () => step(PAGE_STEP),
      left: () => moveView(-1),
      h: () => moveView(-1),
      right: () => moveView(1),
      l: () => moveView(1),
      r: () => apply("retry"),
      t: () => apply("takeOver"),
      f: () => apply("focus"),
      e: () => apply("intervene"),
      x: () => apply("descend"),
      u: () => apply("unassign"),
      d: () => apply(key.shift ? "complete" : "release"),
      D: () => apply("complete"),
      c: () => apply("close"),
      o: () => apply("onboard"),
      s: () => apply("adopt"),
    };
    keyboardActions[key.name]?.();
  });

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <Tabs views={views} selected={view} state={props.state} select={(name) => select(name)} />
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
          <Show when={row().unreviewed}>
            {(branch: Accessor<Unreviewed>) => <text>{`project   ${branch().project}`}</text>}
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
  column === "decisions" || column === "yours" || column === "held" || column === "unreviewed"
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
 * still has to say whether it is paused, draining, or simply out of work. The
 * key's label names the state it moves to rather than the state it is in,
 * because the three cycle and the operator is choosing where to stop.
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
        {`${props.state().dispatch}  ·  ${readAge(props.state(), now())}  ·  ${attentionStatus(props.state())}`}
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
                `p ${nextDispatch(props.state().dispatch)}`,
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
  return Match.value(column).pipe(
    Match.when("queue", () => state.queue.map((task) => readyRow(task, "queue", state))),
    Match.when("working", () => state.working.map((active) => activeRow(active, "working", state))),
    Match.when("review", () => state.review.map((active) => activeRow(active, "review", state))),
    Match.when("landed", () => state.landed.map((task) => landedRow(task, state))),
    Match.when("decisions", () => state.decisions.map((active) => decisionRow(active, state))),
    Match.when("yours", () => state.yours.map((task) => readyRow(task, "yours", state))),
    Match.when("held", () => state.held.map(heldRow)),
    Match.when("unreviewed", () => state.unreviewed.map(unreviewedRow)),
    Match.exhaustive,
  );
};

const rowsForView = (view: ViewName, state: FleetState): ReadonlyArray<ColumnRow> => {
  if (view !== "attention") return rowsFor(view, state);
  return [
    ...rowsFor("decisions", state),
    ...rowsFor("yours", state).map(attentionRow("needs you")),
    ...rowsFor("unreviewed", state).map(attentionRow("unreviewed")),
    ...rowsFor("held", state).map(attentionRow("held")),
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
  label: `${task.project}  ${state.resumable.has(task.id) ? "resume  " : ""}${task.title}`,
  task: undefined,
  ready: task,
  worker: undefined,
  project: undefined,
  reason: undefined,
  unreviewed: undefined,
  failure: undefined,
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
  reason: undefined,
  unreviewed: undefined,
  failure: undefined,
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
  reason: undefined,
  unreviewed: undefined,
  failure: undefined,
  hasWork: state.resumable.has(task.id),
  committed: state.committed.has(task.id),
});

const decisionRow = ({ task, worker, kind, failure }: Active, state: FleetState): ColumnRow => ({
  column: "decisions",
  key: task.id,
  // The reason leads: it is the question the column exists to answer, and it
  // is the half that must survive a narrow terminal truncating the line. An
  // orphaned workspace names its status rather than the kind that left it:
  // done and canceled are pure cleanup, a queued task will be dispatched again
  // into a fresh workspace once this one is closed. A dispatch failure names
  // the error, because that is what the operator must clear before retrying.
  label:
    failure !== undefined
      ? `dispatch failed  ${task.id}  ${failure}`
      : decisionKind(task) === "orphaned workspace"
        ? `orphaned workspace  ${task.id}  ${task.status}`
        : `${decisionKind(task)}  ${task.id}  ${kind ?? "?"}`,
  task,
  ready: undefined,
  worker,
  project: undefined,
  reason: undefined,
  unreviewed: undefined,
  failure,
  hasWork: worker !== undefined || state.resumable.has(task.id),
  committed: state.committed.has(task.id),
});

const heldRow = (held: Held): ColumnRow => ({
  column: "held",
  key: held.project,
  // The reason follows the name, so a narrow terminal that truncates the line
  // still says which project is held. The reason is the part worth waiting
  // out or fixing: a dirty tree clears itself, a missing landing target never
  // does.
  label: `${held.project}  ${held.detail}`,
  task: undefined,
  ready: undefined,
  worker: undefined,
  project: held.project,
  reason: held.reason,
  unreviewed: undefined,
  failure: undefined,
  hasWork: false,
  committed: false,
});

// A branch whose task is gone has no id to dispatch against, so the row says
// so rather than offering a key that would do nothing.
const unreviewedRow = (branch: Unreviewed): ColumnRow => ({
  column: "unreviewed",
  key: branch.branch,
  label: `${branch.branch}  ${branch.title ?? "task deleted — recover by hand"}`,
  task: undefined,
  ready: undefined,
  worker: undefined,
  project: undefined,
  reason: undefined,
  unreviewed: branch,
  failure: undefined,
  hasWork: true,
  committed: true,
});
