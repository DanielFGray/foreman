/**
 * The fleet as other programs read it: one projection of a reading, printed by
 * `foreman status --json` and written to `state.json` by the host that runs
 * the dispatcher (herdr-web's server) after every reading.
 *
 * A view, not a memory. Nothing in foreman reads the file back, so a restart
 * loses nothing by overwriting it, and a reader that finds it stale is told so
 * by `observedAt`. The herdr-app panel is the reader it is shaped for: plain
 * JavaScript that cannot share these types, which is why the shape carries a
 * `version` and is encoded through a schema rather than whatever
 * `JSON.stringify` makes of the state.
 */
import { DateTime, Effect, FileSystem, Option, Path, Schema as S } from "effect";
import type { FleetState } from "./dispatcher.ts";
import type { EpicProgress, Item } from "./records.ts";
import type { Placement } from "./pipeline.ts";
import { BOARD_COLUMNS, columnOf, recentlyLanded } from "./board.ts";
import { coveringOf, gatedSteps } from "./pipeline-graph.ts";
import { MODES, modeOf, Policy } from "./policy.ts";
import {
  actionsFor,
  queueRows,
  rowsForView,
  VIEWS,
  type Action,
  type ColumnRow,
  type ViewName,
} from "./view.ts";

/**
 * Bumped whenever a field a reader relies on changes meaning or goes away.
 * Two readers check it: the herdr-app panel (`herdr/foreman/main.js`) and
 * herdr-web's Foreman page (`src/shared/Foreman.ts` there).
 */
export const PUBLISHED_VERSION = 5;

/**
 * The views the file carries: foreman's own. The queue is not one of them.
 * It is the task store's ready list as foreman ranks it, read on demand with
 * `foreman queue` or `queueOf`, so a reader shows it for the project it is
 * looking at.
 */
export const PUBLISHED_VIEWS = VIEWS.filter((view) => view !== "queue");

export const PublishedRow = S.Struct({
  view: S.Literals(VIEWS),
  key: S.String,
  label: S.String,
  detail: S.NullOr(S.String),
  project: S.NullOr(S.String),
  /** The epic the row's task sits under, so a reader can group a queue by it. */
  parent: S.NullOr(S.String),
  /** Whether the row is an epic, which takes no launch: an epic has no branch and no worker. */
  epic: S.Boolean,
  /** The one-shot subcommands this row takes: `foreman <action> <key>`. */
  actions: S.Array(S.String),
});
export type PublishedRow = typeof PublishedRow.Type;

/**
 * Where one task stands at a block of its project's pipeline. `state` is the
 * run's state at a work block, or `parked` at a park block; `gates` are the
 * gates that hold it before that block, in route order.
 */
export const PublishedPlacement = S.Struct({
  key: S.String,
  label: S.String,
  project: S.String,
  node: S.String,
  /** The block a board draws the task on (`stands` on a placement); `node` is the block it waits for or runs at. */
  stands: S.String,
  state: S.Literals(["waiting", "running", "ended", "parked"]),
  gates: S.Array(S.Struct({ id: S.String, step: S.String })),
  /** The board column the task shows in (`columnOf`). */
  column: S.Literals(BOARD_COLUMNS),
  /**
   * The grant that lets the dispatcher take some of the project's
   * `grantSteps` for the task, and how many tasks it admits still.
   */
  grant: S.NullOr(S.Struct({ scope: S.String, steps: S.Array(S.String), left: S.NullOr(S.Int) })),
  /**
   * The task's runs, oldest first: the block each ran at, its role, its rung,
   * whether it is still open, and how it ended. A closed run that foreman did
   * not settle has no ending; a run from before blocks were recorded has no block.
   */
  runs: S.Array(
    S.Struct({
      node: S.NullOr(S.String),
      role: S.Literals(["author", "review", "check"]),
      rung: S.NullOr(S.String),
      open: S.Boolean,
      ending: S.NullOr(S.String),
    }),
  ),
});
export type PublishedPlacement = typeof PublishedPlacement.Type;

/**
 * What the dispatcher is doing: the policy's mode while it runs (`modeOf`), or
 * `failed` while its host waits to start it again, with why it stopped.
 */
export const DispatcherStatus = S.Union([
  S.Struct({ state: S.Literals(MODES) }),
  S.Struct({ state: S.Literal("failed"), detail: S.String }),
]);
export type DispatcherStatus = typeof DispatcherStatus.Type;

/** The status of a dispatcher that is running, read off its last reading's policy. */
export const statusOf = (state: FleetState): DispatcherStatus => ({ state: modeOf(state.policy) });

export const Published = S.Struct({
  version: S.Literal(PUBLISHED_VERSION),
  /**
   * The dispatcher that made this reading, or null for a one-shot
   * `foreman status`, which runs none and so cannot say what one is doing.
   */
  dispatcher: S.NullOr(DispatcherStatus),
  /** The policy the reading decided from; `foreman policy` changes it. */
  policy: Policy,
  /** Why the policy file could not be read, which pauses the fleet. */
  policyError: S.NullOr(S.String),
  /** ISO instant of the reading, or null before the first one completes. */
  observedAt: S.NullOr(S.String),
  /**
   * The managed projects and their checkouts, for a reader that offers a
   * choice of project. `grantSteps` are the steps a grant from a board gives a
   * task (`gatedSteps`); a reader takes no drop where they are empty.
   */
  projects: S.Array(
    S.Struct({ name: S.String, directory: S.String, grantSteps: S.Array(S.String) }),
  ),
  rows: S.Array(PublishedRow),
  /**
   * Each task that stands at a block, in the order the dispatcher placed
   * them: the queue first, in dispatch order. A task outside any pipeline is
   * left out.
   */
  placements: S.Array(PublishedPlacement),
  /** The projects whose pipeline cannot run, and why. Such a project places no task. */
  stopped: S.Array(S.Struct({ project: S.String, problems: S.Array(S.String) })),
  /** The board's Landed column: tasks that landed in the last `LANDED_HOURS`, newest first. */
  landed: S.Array(
    S.Struct({ key: S.String, label: S.String, project: S.String, landedAt: S.String }),
  ),
});
export type Published = typeof Published.Type;

/** Every row of every view, with the commands each takes. */
export const publishedOf = (
  state: FleetState,
  dispatcher: Option.Option<DispatcherStatus>,
): Published => {
  const grantStepsOf = (project: string) => {
    const found = state.pipelines.get(project);
    return found?._tag === "Runs"
      ? gatedSteps(found.pipeline, state.policy, project).grantSteps
      : [];
  };
  const asksYou = new Set([...state.asks, ...state.decisions].map(({ task }) => task.id));
  return {
    version: PUBLISHED_VERSION,
    dispatcher: Option.getOrNull(dispatcher),
    policy: state.policy,
    policyError: state.policyError ?? null,
    observedAt: state.observedAt === undefined ? null : DateTime.formatIso(state.observedAt),
    projects: state.projects.map(({ name, directory }) => ({
      name,
      directory,
      grantSteps: grantStepsOf(name),
    })),
    rows: PUBLISHED_VIEWS.flatMap((view) => rowsForView(view, state).map(publishedRow(view))),
    placements: state.placed.flatMap(({ task, placement }) =>
      placement._tag === "Outside"
        ? []
        : [
            {
              key: task.id,
              label: task.title,
              project: task.project,
              ...placementOf(placement),
              column: columnOf(task, placement, asksYou.has(task.id)),
              grant: coveringOf(state.policy, state.scopes, task, grantStepsOf(task.project)),
              runs: task.runs.map((run) => ({
                node: run.node ?? null,
                role: run.role,
                rung: run.rung ?? null,
                open: run.open,
                ending: run.ending ?? null,
              })),
            },
          ],
    ),
    stopped: [...state.pipelines].flatMap(([project, found]) =>
      found._tag === "Stopped" ? [{ project, problems: [...found.problems] }] : [],
    ),
    landed:
      state.observedAt === undefined
        ? []
        : recentlyLanded(state.landed, state.observedAt).map((item) => ({
            key: item.id,
            label: item.title,
            project: item.project,
            landedAt: item.lastActivityAt.toISOString(),
          })),
  };
};

const placementOf = (
  placement: Exclude<Placement, { readonly _tag: "Outside" }>,
): Pick<PublishedPlacement, "node" | "stands" | "state" | "gates"> => {
  switch (placement._tag) {
    case "Parked":
      return { node: placement.node, stands: placement.node, state: "parked", gates: [] };
    case "At":
      return {
        node: placement.node.id,
        stands: placement.stands,
        state: placement.state,
        gates: placement.gates.map(({ id, step }) => ({ id, step })),
      };
  }
};

/** One row as a reader sees it, with the commands it takes. `foreman queue` prints these too. */
export const publishedRow =
  (view: ViewName) =>
  (row: ColumnRow): PublishedRow => ({
    view,
    key: row.key,
    label: row.label,
    detail: row.detail ?? null,
    project: row.project ?? row.task?.project ?? row.ready?.project ?? null,
    parent: row.task?.parent ?? row.ready?.parent ?? null,
    epic: row.task?.type === "epic",
    actions: actionsFor(row.column, row).map(commandName),
  });

/** The queue as a reader sees it, each epic before its first task: what `foreman queue --json` prints. */
export const publishedQueue = (
  queue: ReadonlyArray<Item>,
  epics: ReadonlyArray<EpicProgress>,
): ReadonlyArray<PublishedRow> => queueRows(queue, epics).map(publishedRow("queue"));
/** An action as a command line writes it: `takeOver` is `take-over`. */
export const commandName = (action: Action): string =>
  action.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** Where the dispatcher's host publishes, beside the log. */
export const publishedPath = (): string => {
  const stateHome = process.env["XDG_STATE_HOME"] ?? `${process.env["HOME"] ?? ""}/.local/state`;
  return process.env["FOREMAN_STATE"] ?? `${stateHome}/foreman/state.json`;
};

/**
 * Replaces the published file whole.
 *
 * Written to a dot-file in the same folder and renamed over, so a reader never
 * sees half a file: rename is atomic only within one filesystem, and a watcher
 * of the folder is told about the dot-file too, which is why it is hidden.
 */
export const writePublished = (path: string, published: Published) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const text = `${JSON.stringify(yield* S.encodeEffect(Published)(published))}\n`;
    const temporary = paths.join(paths.dirname(path), `.${paths.basename(path)}.tmp`);
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true });
    yield* fs.writeFileString(temporary, text);
    yield* fs.rename(temporary, path);
  });
