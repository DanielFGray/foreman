import { Option } from "effect";
import type { Dispatcher, FleetState } from "./dispatcher.ts";
import { actionsFor, rowsForView, type Action, type ColumnRow } from "./view.ts";
import { VIEWS } from "./view-names.ts";

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

/** The dispatcher's target for an intervention on a row, or `undefined` when the row names no task. */
const interventionOf = (row: ColumnRow) => {
  // A queue row holds its task as `ready` and a claimed one as `task`.
  const target = row.task ?? row.ready;
  return target ? { task: target, worker: row.worker } : undefined;
};

// One function per action. Each returns the dispatcher's call on the row, or
// `undefined` when the row lacks the part the action works on. No return type
// is annotated: each keeps the dispatcher's concrete success and failure types,
// which the CLI verbs export and the UI contract types against.

export const performComplete = (
  dispatcher: Dispatcher["Service"],
  row: ColumnRow,
  reason: string,
) => (row.ready ? dispatcher.complete(row.ready, reason) : undefined);

export const performKill = (
  dispatcher: Dispatcher["Service"],
  row: ColumnRow,
  reason: Option.Option<string>,
) => {
  const intervention = interventionOf(row);
  return intervention?.worker ? dispatcher.kill(intervention, reason) : undefined;
};

export const performIntervene = (
  dispatcher: Dispatcher["Service"],
  row: ColumnRow,
  how: Intervention,
  rung: string | undefined,
) => {
  const intervention = interventionOf(row);
  if (!intervention) return undefined;
  if (how === "review") return dispatcher.reviewIntervention(intervention, rung);
  if (rung === undefined) return undefined;
  return how === "continue"
    ? dispatcher.continueAt(intervention, rung)
    : dispatcher.diagnose(intervention, "diagnose", rung);
};

export const performRetry = (dispatcher: Dispatcher["Service"], row: ColumnRow) =>
  row.task ? dispatcher.retry(row.task) : undefined;

export const performRelease = (dispatcher: Dispatcher["Service"], row: ColumnRow) =>
  row.task ? dispatcher.release(row.task) : undefined;

// Named by the workspace, not the task: an orphaned workspace is one whose task
// the store has deleted, and it is closed the same way.
export const performClose = (dispatcher: Dispatcher["Service"], row: ColumnRow) =>
  row.worker
    ? dispatcher.close({ task: row.worker.task, repository: row.worker.repository })
    : undefined;

export const performFocus = (dispatcher: Dispatcher["Service"], row: ColumnRow) =>
  row.worker ? dispatcher.focus(row.worker) : undefined;

export const performDescend = (dispatcher: Dispatcher["Service"], row: ColumnRow) => {
  const target = row.task ?? row.ready;
  return target ? dispatcher.descend(target) : undefined;
};

export const performUnassign = (dispatcher: Dispatcher["Service"], row: ColumnRow) => {
  const target = row.task ?? row.ready;
  return target ? dispatcher.unassign(target) : undefined;
};

export const performOnboard = (dispatcher: Dispatcher["Service"], row: ColumnRow) =>
  row.project ? dispatcher.onboard(row.project) : undefined;

export const performAdopt = (dispatcher: Dispatcher["Service"], row: ColumnRow) =>
  row.unreviewed ? dispatcher.adopt(row.unreviewed) : undefined;

export const performApprove = (dispatcher: Dispatcher["Service"], row: ColumnRow) =>
  row.ask ? dispatcher.approve(row.ask) : undefined;

export const performPreview = (dispatcher: Dispatcher["Service"], row: ColumnRow) =>
  row.worker && row.preview ? dispatcher.preview(row.worker, row.preview) : undefined;

/**
 * The dispatcher command a request means on this row, or `undefined` when the
 * row cannot take it. The dashboard's entry point: each arm calls one of the
 * `perform*` functions above, so a key and a subcommand share one path.
 *
 * `undefined` covers both an action the row's column does not offer and a row
 * missing the part the action works on, so a caller has one refusal to report.
 */
export const perform = (dispatcher: Dispatcher["Service"], row: ColumnRow, request: Request) => {
  if (!actionsFor(row.column, row).includes(request.action)) return undefined;
  switch (request.action) {
    case "complete":
      return performComplete(dispatcher, row, request.reason);
    case "kill":
      return performKill(dispatcher, row, request.reason);
    case "intervene":
      return performIntervene(dispatcher, row, request.how, request.rung);
    case "retry":
      return performRetry(dispatcher, row);
    case "release":
      return performRelease(dispatcher, row);
    case "close":
      return performClose(dispatcher, row);
    case "takeOver":
    case "focus":
      return performFocus(dispatcher, row);
    case "descend":
      return performDescend(dispatcher, row);
    case "unassign":
      return performUnassign(dispatcher, row);
    case "onboard":
      return performOnboard(dispatcher, row);
    case "adopt":
      return performAdopt(dispatcher, row);
    case "approve":
      return performApprove(dispatcher, row);
    case "preview":
      return performPreview(dispatcher, row);
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
  unassign: "End an open review run that no reviewer is behind",
  onboard: "Send an agent to salvage the uncommitted work holding a project",
  adopt: "Put an unread branch in front of a reviewer",
  approve: "Allow the step a task is waiting on, once, for that task alone",
  preview:
    "Run the project's scripts/preview.sh in a task's worktree, in the terminal preview-<task>",
};
