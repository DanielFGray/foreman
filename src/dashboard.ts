import { FileSystem } from "@effect/platform";
import { Effect, Match, Ref, Stream, SubscriptionRef } from "effect";
import {
  Dispatcher,
  nextDispatch,
  type FleetState,
  type InterventionTarget,
} from "./dispatcher.ts";
import { logPath } from "./log.ts";
import { Screen, type Frame, type Keypress } from "./screen.ts";
import {
  actionsFor,
  climbing,
  drawn,
  FOLLOW_VIEWS,
  keyLine,
  previewOf,
  commandFor,
  isAction,
  rowsForView,
  showKey,
  statusLine,
  tabs,
  VIEWS,
  type Action,
  type ColumnRow,
  type ViewName,
} from "./view.ts";
import { failuresOf } from "./prog.ts";
import { stats } from "./stats.ts";

/**
 * The dashboard: the dispatcher's reading of the world, projected onto a
 * screen, and the operator's keys turned back into its commands.
 *
 * Nothing here draws. `view.ts` says what the rows are and which keys they
 * take, `screen.ts` puts them on a terminal, and this decides which view the
 * operator is looking at and what a key means in it. The three parts do not
 * share state: every redraw rebuilds the whole frame from the last reading,
 * so there is no screen to keep in step with the world.
 *
 * Each command is forked rather than awaited, so the screen never waits on a
 * herdr or prog round trip.
 */
export const dashboard = Effect.gen(function* () {
  const dispatcher = yield* Dispatcher;
  const screen = yield* Screen;
  const fs = yield* FileSystem.FileSystem;
  const ui = yield* Ref.make<Ui>({ view: "queue", mode: BROWSE, attention: false });

  const run = <E, R>(command: Effect.Effect<unknown, E, R>) =>
    Effect.forkScoped(Effect.catchAllCause(command, Effect.logError));

  /**
   * Rebuilds the frame from the dispatcher's last reading.
   *
   * The cursor is read back from the screen rather than remembered, for the
   * same reason foreman reads the fleet back rather than remembering it: the
   * operator moves it with keys the screen handles by itself. It is needed
   * here only to decide whether the task being watched has moved to another
   * view, which is the one case where foreman moves the cursor deliberately.
   */
  const redraw = Effect.fnUntraced(function* (moveTo?: ViewName) {
    const state = yield* SubscriptionRef.get(dispatcher.state);
    const before = yield* Ref.get(ui);
    const tracked = yield* screen.cursor;
    // A view the operator asked for is not a view to be followed out of.
    // The follow exists to chase a task that moved by itself; letting it run
    // here would read the cursor still sitting in the view just left and
    // drag the operator straight back to it.
    const after =
      moveTo === undefined
        ? place(before, state, tracked)
        : { ...before, view: moveTo, attention: rowsForView("attention", state).length > 0 };
    if (after !== before) yield* Ref.set(ui, after);
    // The accounts are read from the network, and a paused fleet has no
    // other reason to ask. Only the screen knows whether anyone is looking,
    // so entering and leaving the view is what says so — on the change, not
    // on every redraw, because the clock redraws once a second.
    if (after.view !== before.view) {
      yield* run(dispatcher.watchQuota(after.view === "quota"));
    }
    const moved =
      moveTo !== undefined || after.view !== before.view || after.mode.kind !== before.mode.kind;
    yield* screen.show(yield* frame(after, state, tracked, dispatcher.rungs, fs, moved));
  });

  const enter = Effect.fnUntraced(function* (mode: Mode) {
    yield* Ref.update(ui, (current) => ({ ...current, mode }));
    yield* screen.mode(inputFor(mode));
    yield* redraw();
  });

  const act = Effect.fnUntraced(function* (action: Action, row: ColumnRow) {
    if (!actionsFor(row.column, row).includes(action)) return yield* screen.reject;
    const task = row.task;
    const target = climbing(row);
    return yield* Match.value(action).pipe(
      // Both of these ask the operator a question before anything happens,
      // so they open a prompt rather than issuing a command.
      Match.when("complete", () => enter({ kind: "reason", row })),
      Match.when("kill", () => enter({ kind: "kill", row })),
      Match.when("intervene", () => enter({ kind: "intervene", row })),
      Match.when("retry", () => (task ? run(dispatcher.retry(task)) : screen.reject)),
      Match.when("release", () => (task ? run(dispatcher.release(task)) : screen.reject)),
      // Named by the workspace, not the task: an orphaned workspace is one
      // whose task the store has deleted, and it is closed the same way.
      Match.when("close", () =>
        row.worker
          ? run(dispatcher.close({ task: row.worker.task, repository: row.worker.repository }))
          : screen.reject,
      ),
      Match.when("takeOver", () =>
        row.worker ? run(dispatcher.focus(row.worker)) : screen.reject,
      ),
      Match.when("focus", () => (row.worker ? run(dispatcher.focus(row.worker)) : screen.reject)),
      // A queue row carries its task as `ready` and a claimed one as `task`;
      // the pin is on the id either way, which is the only part both have.
      Match.when("pin", () => {
        const id = row.ready?.id ?? row.task?.id;
        return id ? run(dispatcher.togglePin(id)) : screen.reject;
      }),
      Match.when("descend", () => (target ? run(dispatcher.descend(target)) : screen.reject)),
      Match.when("unassign", () => (target ? run(dispatcher.unassign(target)) : screen.reject)),
      Match.when("onboard", () =>
        row.project ? run(dispatcher.onboard(row.project)) : screen.reject,
      ),
      Match.when("adopt", () =>
        row.unreviewed ? run(dispatcher.adopt(row.unreviewed)) : screen.reject,
      ),
      Match.exhaustive,
    );
  });

  const moveView = (delta: number) =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.get(dispatcher.state);
      const current = yield* Ref.get(ui);
      const visible = drawn(state);
      if (visible.length === 0) return;
      const index = visible.indexOf(current.view);
      const next = visible[(index + delta + visible.length) % visible.length];
      yield* redraw(next);
    });

  const browse = (press: Keypress) =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.get(dispatcher.state);
      const current = yield* Ref.get(ui);
      // A click on the tab strip names its view in the row field, because the
      // strip has no row and the word under the pointer is the whole address.
      if (press.key === "click-tab") {
        const view = VIEWS.find((name) => press.row?.includes(name));
        return view === undefined ? undefined : yield* redraw(view);
      }
      const command = commandFor(press.key);
      if (command === undefined) return;
      if (isAction(command)) {
        const row = rowsForView(current.view, state).find(
          (candidate) => candidate.key === press.row,
        );
        return row === undefined ? undefined : yield* act(command, row);
      }
      return yield* Match.value(command).pipe(
        Match.when("quit", () => screen.close),
        Match.when("log", () => enter({ kind: "log" })),
        Match.when("stats", () => run(stats)),
        Match.when("viewLeft", () => moveView(-1)),
        Match.when("viewRight", () => moveView(1)),
        Match.when("dispatch", () =>
          run(dispatcher.setDispatch(nextDispatch(state.dispatch))).pipe(Effect.andThen(redraw())),
        ),
        Match.exhaustive,
      );
    });

  /**
   * An intervention, which is a question about how to resume a task rather
   * than a command: continue at a rung, or send a diagnostic agent at what an
   * earlier attempt left behind.
   *
   * The choices are the list rather than three more keys, for the same reason
   * choosing a rung is: the screen is a list, so a question with a handful of
   * answers is what the list holds while it is open. It also keeps the three
   * out of the keymap, where they would have had to be modified keys that mean
   * something in one mode only.
   */
  const intervene = Effect.fnUntraced(function* (press: Keypress, row: ColumnRow) {
    if (press.key === "esc") return yield* enter(BROWSE);
    if (press.key !== "enter") return;
    // A committed attempt has a diff, so it goes through the formal verdict
    // pipeline. An uncommitted one has only a worktree, and reading that is
    // a diagnostic agent's job at a rung the operator picks.
    if (press.row === "review" && row.committed) {
      const target = targetOf(row);
      if (target) yield* run(dispatcher.reviewIntervention(target, undefined));
      return yield* enter(BROWSE);
    }
    const action = INTERVENTIONS.find((name) => name === press.row);
    if (action === undefined) return yield* screen.reject;
    return yield* enter({ kind: "rung", row, action });
  });

  const handle = Effect.fnUntraced(function* (press: Keypress) {
    const { mode } = yield* Ref.get(ui);

    switch (mode.kind) {
      case "browse":
        return yield* browse(press);
      case "intervene":
        return yield* intervene(press, mode.row);
      case "rung": {
        if (press.key === "esc") return yield* enter(BROWSE);
        if (press.key !== "enter") return;
        const target = targetOf(mode.row);
        const rung = press.row;
        if (target && rung !== undefined)
          yield* run(
            mode.action === "continue"
              ? dispatcher.continueAt(target, rung)
              : mode.action === "diagnose"
                ? dispatcher.diagnose(target, "diagnose", rung)
                : dispatcher.reviewIntervention(target, rung),
          );
        return yield* enter(BROWSE);
      }
      case "reason": {
        if (press.key === "esc") return yield* enter(BROWSE);
        if (press.key !== "enter") return;
        const reason = press.query.trim();
        // The reason is the whole point of completing a task by hand: it is
        // what the log will say instead of a review's verdict.
        if (reason.length === 0) return yield* screen.reject;
        if (mode.row.ready) yield* run(dispatcher.complete(mode.row.ready, reason));
        return yield* enter(BROWSE);
      }
      case "kill": {
        if (press.key === "esc") return yield* enter(BROWSE);
        if (press.key !== "enter") return;
        const target = targetOf(mode.row);
        const reason = press.query.trim() || "operator killed this attempt";
        if (target?.worker) yield* run(dispatcher.kill(target, reason));
        return yield* enter(BROWSE);
      }
      case "log":
        if (press.key === "esc" || press.key === "f12") return yield* enter(BROWSE);
        return;
    }
  });

  yield* Effect.forkScoped(Stream.runForEach(dispatcher.state.changes, () => redraw()));
  yield* Effect.forkScoped(Stream.runForEach(screen.keys, handle));

  // The age has to advance on its own clock: a tick publishes its reading and
  // then works, and nothing republishes while it works — so an age derived
  // from the reading alone would sit frozen at the very moment it is worth
  // reading. Only the header is rewritten, because a full redraw every second
  // would rewrite every preview on screen to move one number.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.get(dispatcher.state);
      const { view, mode } = yield* Ref.get(ui);
      if (mode.kind === "browse") yield* screen.header(banner(state, view));
    }).pipe(Effect.andThen(Effect.sleep("1 second")), Effect.forever),
  );

  yield* screen.closed;
});

interface Ui {
  readonly view: ViewName;
  readonly mode: Mode;

  /**
   * Whether attention had anything in it at the last redraw.
   *
   * Attention interrupts when it goes from empty to occupied, and must clear
   * before it can interrupt again — otherwise a fleet with one held project
   * would drag the operator back every tick.
   */
  readonly attention: boolean;
}

type Mode =
  | { readonly kind: "browse" }
  | { readonly kind: "log" }
  | { readonly kind: "intervene"; readonly row: ColumnRow }
  | { readonly kind: "reason"; readonly row: ColumnRow }
  | { readonly kind: "kill"; readonly row: ColumnRow }
  | {
      readonly kind: "rung";
      readonly row: ColumnRow;
      readonly action: Intervention;
    };

/** The ways an intervention can resume a task, in the order they are offered. */
const INTERVENTIONS = ["continue", "diagnose", "review"] as const;
type Intervention = (typeof INTERVENTIONS)[number];

const INTERVENTION_LABELS: Record<Intervention, string> = {
  continue: "resume the task at a rung you pick, keeping the worktree",
  diagnose: "send a diagnostic agent at what the last attempt left",
  review: "review what the last attempt produced",
};

const BROWSE: Mode = { kind: "browse" };

/**
 * Whether what is typed narrows the list.
 *
 * Everywhere but one: filtering by typing is how the operator reaches the row
 * they were told about. The exception is the reason prompt, where the typing
 * is a sentence and narrowing would throw the list away a word in.
 */
const inputFor = (mode: Mode) =>
  mode.kind === "reason" || mode.kind === "kill" ? "answer" : "search";

const targetOf = (row: ColumnRow): InterventionTarget | undefined => {
  const task = row.task ?? row.ready;
  return task ? { task, worker: row.worker } : undefined;
};

/**
 * Which view the operator ends up looking at, and whether attention just took
 * them there.
 *
 * Three rules, in order: a view that emptied hands the cursor to the nearest
 * tab on its left; attention interrupts when it fills; and the tracked task is
 * followed if it moved to another view that follows it. Landing is not
 * followed — chasing finished work into history walks the operator out of the
 * work still to do.
 */
const place = (current: Ui, state: FleetState, tracked: string | undefined): Ui => {
  if (current.mode.kind !== "browse") return current;
  const visible = drawn(state);
  const attention = rowsForView("attention", state).length > 0;
  const settled = { ...current, attention };

  if (attention && !current.attention && visible.includes("attention"))
    return { ...settled, view: "attention" };

  const view = visible.includes(current.view) ? current.view : nearest(current.view, visible);
  if (tracked !== undefined && !rowsForView(view, state).some((row) => row.key === tracked)) {
    const followed = FOLLOW_VIEWS.find(
      (name) =>
        visible.includes(name) && rowsForView(name, state).some((row) => row.key === tracked),
    );
    if (followed !== undefined) return { ...settled, view: followed };
  }
  return view === current.view ? settled : { ...settled, view };
};

/** A view that empties gives the cursor to the nearest tab to its left. */
const nearest = (gone: ViewName, visible: ReadonlyArray<ViewName>): ViewName => {
  const index = VIEWS.indexOf(gone);
  return visible.filter((name) => VIEWS.indexOf(name) < index).at(-1) ?? visible[0] ?? gone;
};

/**
 * The whole screen, for whatever the dashboard is currently showing.
 *
 * A prompt replaces the list rather than sitting beside it: choosing a rung is
 * a list, and the screen is a list, so the mode is what the list holds. That
 * is also why the cursor is only ever named when the frame moves it — leaving
 * it out is what lets the screen keep tracking the row it already had.
 */
const frame = (
  ui: Ui,
  state: FleetState,
  tracked: string | undefined,
  rungs: ReadonlyArray<string>,
  fs: FileSystem.FileSystem,
  moved: boolean,
): Effect.Effect<Frame, never> =>
  Effect.gen(function* () {
    const header = banner(state, ui.view);

    if (ui.mode.kind === "log") {
      const lines = yield* fs.readFileString(logPath()).pipe(
        Effect.map(tail),
        Effect.orElseSucceed(() => ["the log is not readable"]),
      );
      const footer = `${showKey("log")} or Esc back  ·  type to filter  ·  ^p/^n move`;
      return {
        rows: lines.map((line, index) => ({ key: String(index), line, preview: line, footer })),
        header: "log",
        prompt: "log> ",
        cursor: String(lines.length - 1),
      };
    }

    if (ui.mode.kind === "rung") {
      const { row, action } = ui.mode;
      // A task records which rungs failed it, so the list says which have been
      // spent here and lands the cursor on the one that would run next — the
      // question the operator is answering is whether to take a different one.
      const tried = new Set(failuresOf(climbing(row) ?? { labels: [] }));
      const next = rungs.find((rung) => !tried.has(rung));
      const footer = "Enter confirm  ·  Esc cancel";
      return {
        rows: rungs.map((rung) => ({
          key: rung,
          line: tried.has(rung) ? `${rung}  (tried)` : rung === next ? `${rung}  (next)` : rung,
          preview: `${action} at ${rung}\n\n${previewOf(row)}`,
          footer,
        })),
        header,
        prompt: `${action} rung> `,
        cursor: next ?? rungs[0],
      };
    }

    const rows = rowsForView(ui.view, state);
    // The id leads the line rather than hiding in the row's identity field,
    // because typing it is how the operator reaches a row somebody named to
    // them, and only what is displayed is what the search matches. Padded to
    // the widest in the frame so the labels line up under each other.
    const width = Math.max(0, ...rows.map((row) => row.key.length));
    const withFooter = (footer: (row: ColumnRow) => string) =>
      rows.map((row) => ({
        key: row.key,
        line: `${row.key.padEnd(width)}  ${row.label}${row.detail === undefined ? "" : `\n  ${row.detail}`}`,
        preview: previewOf(row),
        footer: footer(row),
      }));

    if (ui.mode.kind === "reason")
      return {
        rows: withFooter(() => "Enter confirm  ·  Esc cancel"),
        header,
        prompt: `reason for ${ui.mode.row.key}> `,
        cursor: ui.mode.row.key,
      };

    if (ui.mode.kind === "kill")
      return {
        rows: withFooter(() => "Enter confirm  ·  Esc cancel"),
        header,
        prompt: `why kill ${ui.mode.row.key}> `,
        cursor: ui.mode.row.key,
      };

    if (ui.mode.kind === "intervene") {
      const { row } = ui.mode;
      const footer = "Enter confirm  ·  Esc cancel";
      // Diagnose and Review are offered only where an attempt left something
      // to read: a worktree for the first, commits for the second.
      const offered = INTERVENTIONS.filter((action) =>
        action === "diagnose"
          ? row.hasWork
          : action === "review"
            ? row.committed || row.hasWork
            : true,
      );
      return {
        rows: offered.map((action) => ({
          key: action,
          line: `${action}  ${INTERVENTION_LABELS[action]}`,
          preview: `${action} ${row.key}\n\n${previewOf(row)}`,
          footer,
        })),
        header,
        prompt: `intervene in ${row.key}> `,
        cursor: offered[0],
      };
    }

    return {
      rows: withFooter((row) => keyLine(actionsFor(row.column, row), state)),
      header,
      prompt: "> ",
      // The cursor is only placed when foreman moved the operator somewhere:
      // an ordinary tick leaves it alone, and the screen keeps it on the row
      // it was tracking however the list was reordered underneath.
      cursor: moved ? (tracked ?? rows[0]?.key) : undefined,
    };
  });

/**
 * The tab strip, and under it how the fleet is doing.
 *
 * Both belong to the frame rather than to a row, and both change without the
 * cursor moving, which is why they are the header while the keys a row takes
 * are the footer.
 */
const banner = (state: FleetState, view: ViewName): string =>
  `${tabs(state, view)}\n${statusLine(state, Date.now())}`;

/** The end of the log, which is the part worth reading on a screen. */
const tail = (content: string): ReadonlyArray<string> =>
  content
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-500)
    .map(readable);

/**
 * One log record as one line.
 *
 * The file is written a record at a time and read while it is being written,
 * so its last line can be half of one. A line that will not parse is shown as
 * it stands rather than ending the read.
 */
const readable = (line: string): string => {
  try {
    const record = JSON.parse(line) as { at: string; level: string; message: string };
    return `${record.at}  ${record.level}  ${record.message.replace(/\n/g, " ")}`;
  } catch {
    return line;
  }
};
