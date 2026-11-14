/** The views the fleet has, named once so schemas can read them without loading the view rules. */
export const VIEWS = ["queue", "working", "review", "landed", "quota", "attention"] as const;
export type ViewName = (typeof VIEWS)[number];

export const ACTIONS_LIST = [
  "complete",
  "retry",
  "release",
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
