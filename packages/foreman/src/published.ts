/**
 * The fleet as other programs read it: one projection of a reading, printed by
 * `foreman status --json` and written to `state.json` by the host that runs
 * `foreman serve` after every reading.
 *
 * A view, not a memory. Nothing in foreman reads the file back, so a restart
 * loses nothing by overwriting it, and a reader that finds it stale is told so
 * by `observedAt`. The herdr-app Foreman pane is the reader it is shaped for: plain
 * JavaScript that cannot share these types, which is why the shape carries a
 * `version` and is encoded through a schema rather than whatever
 * `JSON.stringify` makes of the state.
 */
import { DateTime, Effect, FileSystem, Option, Path, Schema as S } from "effect";
import type { FleetState } from "./dispatcher.ts";
import type { EpicProgress, Item } from "./records.ts";
import type { Placement } from "./pipeline.ts";
import { columnOf, recentlyLanded } from "./board.ts";
import { coveringOf, gatedSteps } from "./pipeline-graph.ts";
import { modeOf, stepModesFor, trackerOf } from "./policy.ts";
import { commandName, type ViewName } from "./view-names.ts";
import { actionsFor, pullRequestView, queueRows, rowsForView, type ColumnRow } from "./view.ts";
import {
  DispatcherStatus,
  PUBLISHED_VERSION,
  PUBLISHED_VIEWS,
  Published,
  PublishedPlacement,
  PublishedRow,
} from "./published-schema.ts";

/** The status of a dispatcher that is running, read off its last reading's policy. */
export const statusOf = (state: FleetState): DispatcherStatus => ({ state: modeOf(state.policy) });

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
    availableMemory: state.availableMemory ?? null,
    workerMemory: Object.fromEntries(state.workerMemory),
    projects: state.projects.map(({ name, directory }) => ({
      name,
      directory,
      grantSteps: grantStepsOf(name),
      tracker: trackerOf(state.policy, name),
      repo: state.repos.get(name) ?? null,
      unreachable:
        state.held.find((held) => held.project === name && held.reason === "unreachable")?.detail ??
        null,
      steps: stepModesFor(state.policy, name),
    })),
    accounts: state.providers.map(({ provider, rungs, reviewers }) => ({
      provider,
      rungs,
      reviewers,
    })),
    rows: PUBLISHED_VIEWS.flatMap((view) =>
      rowsForView(view, state).map(publishedRow(view, state)),
    ),
    placements: state.placed.flatMap(({ task, placement }) =>
      placement._tag === "Outside"
        ? []
        : [
            {
              key: task.id,
              label: task.title,
              project: task.project,
              parent: Option.getOrNull(task.parent),
              ...placementOf(placement),
              column: columnOf(task, placement, asksYou.has(task.id)),
              ...linksOf(state, task.id),
              grant: coveringOf(state.policy, state.scopes, task, grantStepsOf(task.project)),
              runs: task.runs.map((run) => ({
                node: Option.getOrNull(run.node),
                role: run.role,
                rung: Option.getOrNull(run.rung),
                open: run.open,
                ending: Option.getOrNull(run.ending),
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
            parent: Option.getOrNull(item.parent),
            landedAt: item.lastActivityAt.toISOString(),
          })),
    epics: state.epics.map(({ epic, children }) => ({
      key: epic.id,
      label: epic.title,
      project: epic.project,
      done: children.filter((child) => child.status === "done").length,
      total: children.length,
    })),
  };
};

const placementOf = (
  placement: Exclude<Placement, { readonly _tag: "Outside" }>,
): Pick<PublishedPlacement, "node" | "stands" | "state" | "gates"> => {
  switch (placement._tag) {
    case "Parked":
      return { node: placement.node, stands: placement.node, state: "parked", gates: [] };
    case "ExitGone":
      return { node: placement.node, stands: placement.node, state: "gone", gates: [] };
    case "At":
      return {
        node: placement.node.id,
        stands: placement.stands,
        state: placement.state,
        gates: placement.gates.map(({ id, step }) => ({ id, step })),
      };
  }
};

/**
 * One row as a reader sees it, with the commands it takes. `foreman queue`
 * prints these too, from no reading, so its rows carry no links.
 */
export const publishedRow =
  (view: ViewName, state: FleetState | undefined) =>
  (row: ColumnRow): PublishedRow => ({
    view,
    key: row.key,
    label: row.label,
    detail: row.detail ?? null,
    project: row.project ?? row.task?.project ?? row.ready?.project ?? null,
    parent: Option.getOrNull(row.task?.parent ?? row.ready?.parent ?? Option.none()),
    epic: row.task?.type === "epic",
    actions: actionsFor(row.column, row).map(commandName),
    ...(state === undefined
      ? { url: null, pr: null }
      : linksOf(state, row.task?.id ?? row.ready?.id ?? row.key)),
  });

const linksOf = (state: FleetState, task: string): Pick<PublishedRow, "url" | "pr"> => {
  const pr = pullRequestView(state, task);
  return {
    url: state.urls.get(task) ?? null,
    pr: pr === undefined ? null : { ...pr, checks: pr.checks ?? null, waiting: pr.waiting ?? null },
  };
};

/** The queue as a reader sees it, each epic before its first task: what `foreman queue --json` prints. */
export const publishedQueue = (
  queue: ReadonlyArray<Item>,
  epics: ReadonlyArray<EpicProgress>,
): ReadonlyArray<PublishedRow> => queueRows(queue, epics).map(publishedRow("queue", undefined));
/** An action as a command line writes it: `takeOver` is `take-over`. */
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
