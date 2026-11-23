import { Option } from "effect";
import type { Dispatcher, FleetState } from "./dispatcher.ts";
import { actionsFor, rowsForView, type ColumnRow } from "./view.ts";
import { VIEWS, type Action, type Intervention } from "./view-names.ts";

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

export const performRequeueFresh = (dispatcher: Dispatcher["Service"], row: ColumnRow) =>
  row.task ? dispatcher.requeueFresh(row.task) : undefined;

export const performCancel = (dispatcher: Dispatcher["Service"], row: ColumnRow) =>
  row.task ? dispatcher.cancel(row.task) : undefined;

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
