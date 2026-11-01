import { Effect, Option } from "effect";
import type { Dispatcher, FleetState } from "./dispatcher.ts";
import { actionsFor, rowsForView, VIEWS, type Action, type ColumnRow } from "./view.ts";

/**
 * An operator's action on one row, with every answer it needs already given.
 *
 * Two front ends issue these: the dashboard, which asks its questions in a
 * prompt before building one, and the command line, which takes them as
 * flags. Both turn it into a dispatcher command through `perform`, so a key
 * and a subcommand can never mean different things.
 */
export type Request =
  | { readonly action: Exclude<Action, "complete" | "kill" | "intervene"> }
  /** The reason is what the log says instead of a review's verdict. */
  | { readonly action: "complete"; readonly reason: string }
  /** Absent when the operator gave no reason, which writes the bare kill line. */
  | { readonly action: "kill"; readonly reason: Option.Option<string> }
  | {
      readonly action: "intervene";
      readonly how: Intervention;
      /** Absent only for a review of a committed attempt, which has its own verdict pipeline. */
      readonly rung: string | undefined;
    };

/** The ways an intervention can resume a task, in the order they are offered. */
export const INTERVENTIONS = ["continue", "diagnose", "review"] as const;
export type Intervention = (typeof INTERVENTIONS)[number];

/**
 * The dispatcher command a request means on this row, or `undefined` when the
 * row cannot take it.
 *
 * `undefined` covers both an action the row's column does not offer and a row
 * missing the part the action works on, so a caller has one refusal to report.
 */
export const perform = (
  dispatcher: Dispatcher["Service"],
  row: ColumnRow,
  request: Request,
): Effect.Effect<unknown, unknown> | undefined => {
  if (!actionsFor(row.column, row).includes(request.action)) return undefined;
  const task = row.task;
  // A queue row holds its task as `ready` and a claimed one as `task`.
  const target = row.task ?? row.ready;
  const intervention = target ? { task: target, worker: row.worker } : undefined;
  switch (request.action) {
    case "complete":
      return row.ready ? dispatcher.complete(row.ready, request.reason) : undefined;
    case "kill":
      return intervention?.worker ? dispatcher.kill(intervention, request.reason) : undefined;
    case "intervene":
      if (!intervention) return undefined;
      if (request.how === "review")
        return dispatcher.reviewIntervention(intervention, request.rung);
      if (request.rung === undefined) return undefined;
      return request.how === "continue"
        ? dispatcher.continueAt(intervention, request.rung)
        : dispatcher.diagnose(intervention, "diagnose", request.rung);
    case "retry":
      return task ? dispatcher.retry(task) : undefined;
    case "release":
      return task ? dispatcher.release(task) : undefined;
    // Named by the workspace, not the task: an orphaned workspace is one
    // whose task the store has deleted, and it is closed the same way.
    case "close":
      return row.worker
        ? dispatcher.close({ task: row.worker.task, repository: row.worker.repository })
        : undefined;
    case "takeOver":
    case "focus":
      return row.worker ? dispatcher.focus(row.worker) : undefined;
    case "descend":
      return target ? dispatcher.descend(target) : undefined;
    case "unassign":
      return target ? dispatcher.unassign(target) : undefined;
    case "onboard":
      return row.project ? dispatcher.onboard(row.project) : undefined;
    case "adopt":
      return row.unreviewed ? dispatcher.adopt(row.unreviewed) : undefined;
  }
};

/**
 * The row an id names that can take this action, across every view.
 *
 * One id can sit in several views at once — a working task whose worker
 * vanished is also a decision in attention — and only some of those rows take
 * a given action, so the first row that does is the one meant. An id is
 * whatever a row is keyed by: a task, a project, a provider or a branch.
 */
export const rowFor = (state: FleetState, id: string, action: Action): ColumnRow | undefined =>
  VIEWS.flatMap((view) => rowsForView(view, state)).find(
    (row) => row.key === id && actionsFor(row.column, row).includes(action),
  );

/**
 * What each action does, for the command line's help and `--skill`.
 *
 * The dashboard's footer names an action by its key's label; a subcommand has
 * no footer, so it carries the sentence instead.
 */
export const ACTION_HELP: Record<Action, string> = {
  complete: "Close a queued task by hand, without a workspace or a landing",
  retry: "Start a fresh agent where a worker vanished or a dispatch failed",
  release: "Hand a claimed task back to the queue and take its workspace down",
  close: "Take down a workspace whose task nothing owns",
  takeOver: "Focus a vanished worker's pane so you can continue by hand",
  focus: "Focus the pane of a task's live agent",
  kill: "Stop a live attempt, log why, and requeue the task on the same rung",
  intervene: "Resume a task at a rung, or send an agent to diagnose or review its last attempt",
  descend: "Take back the last recorded failure, moving the task one rung down",
  unassign: "Clear a review-by label that no reviewer is behind",
  onboard: "Send an agent to salvage the uncommitted work holding a project",
  adopt: "Put an unread branch in front of a reviewer",
};
