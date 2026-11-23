/** The views the fleet has, named once so schemas can read them without loading the view rules. */
export const VIEWS = ["queue", "working", "review", "landed", "quota", "attention"] as const;
export type ViewName = (typeof VIEWS)[number];

export const ACTIONS_LIST = [
  "complete",
  "retry",
  "release",
  "requeueFresh",
  "cancel",
  "close",
  "takeOver",
  "focus",
  "kill",
  "intervene",
  "descend",
  "unassign",
  "onboard",
  "adopt",
  "approve",
  "preview",
] as const;

/** Something an operator does to one row. */
export type Action = (typeof ACTIONS_LIST)[number];

/** The ways an intervention can resume a task, in the order they are offered. */
export const INTERVENTIONS = ["continue", "diagnose", "review"] as const;
export type Intervention = (typeof INTERVENTIONS)[number];

/** The subcommand an action runs as: `takeOver` is `foreman take-over`. */
export const commandName = (action: Action): string =>
  action.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The action a subcommand name runs, as a published row lists it; undefined for any other name. */
export const actionNamed = (name: string): Action | undefined =>
  ACTIONS_LIST.find((action) => commandName(action) === name);

/** The actions that take nothing but the row's key. */
export const KEY_ONLY_ACTIONS = [
  "retry",
  "release",
  "requeueFresh",
  "cancel",
  "close",
  "takeOver",
  "focus",
  "descend",
  "unassign",
  "onboard",
  "adopt",
  "approve",
  "preview",
] as const satisfies ReadonlyArray<Action>;

/**
 * What each action does: a subcommand's help, `--skill`, and the hint on the
 * page's button, so the operator reads the effect before choosing.
 */
export const ACTION_HELP: Record<Action, string> = {
  complete: "Close a queued task by hand, without a workspace or a landing",
  retry: "Start a fresh agent where a worker vanished or a dispatch failed",
  release:
    "Hand a claimed task back to the queue and remove its worktree: commits stay on its branch, uncommitted edits are lost",
  requeueFresh:
    "Delete a returned task's branch and worktree, so its next author starts from the current trunk",
  cancel: "Delete a returned task's branch and worktree, and cancel the task",
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
  preview: "Run the project's scripts/preview in a task's worktree, in the terminal preview-<task>",
};
