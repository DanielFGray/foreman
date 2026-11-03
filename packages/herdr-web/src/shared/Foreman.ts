// What foreman publishes about its fleet, the queue it ranks, and the commands
// the page may ask the bridge to run. The reading is a copy of foreman's own
// `Published` (src/published.ts there), version 5, holding the fields this
// page reads. A queue row has the same shape as a published row. Foreman's
// modules are not browser-safe, so this copy stands in for them.
import { Match, Schema as S } from "effect"

/** The version of foreman's published shape this page reads. */
export const FOREMAN_VERSION = 6

export const FOREMAN_STEPS = ["author", "climb", "review", "publish", "land"] as const
export const FOREMAN_STEP_MODES = ["on", "ask", "off"] as const
export const ForemanStep = S.Literals(FOREMAN_STEPS)
export type ForemanStep = typeof ForemanStep.Type

/** A widening of the default steps for one task or epic; `remaining` counts tasks, and absent means no limit. */
export const ForemanGrant = S.Struct({
  scope: S.String,
  steps: S.Array(ForemanStep),
  remaining: S.optional(S.Int),
  admitted: S.Array(S.String),
})
export type ForemanGrant = typeof ForemanGrant.Type

/**
 * What the fleet does with a step by itself: `on` runs it, `ask` waits for one
 * approval per task, `off` does nothing.
 */
export const ForemanStepMode = S.Literals(FOREMAN_STEP_MODES)
export type ForemanStepMode = typeof ForemanStepMode.Type

/** Which steps the fleet takes by itself, and how many agents may work at once. */
export const ForemanPolicy = S.Struct({
  paused: S.Boolean,
  slots: S.Int,
  default: S.Struct({ author: ForemanStepMode, climb: ForemanStepMode, review: ForemanStepMode, publish: ForemanStepMode, land: ForemanStepMode }),
  grants: S.Array(ForemanGrant),
})
export type ForemanPolicy = typeof ForemanPolicy.Type

export const FOREMAN_VIEWS = ["attention", "working", "review", "queue", "quota", "landed"] as const
export const ForemanView = S.Literals(FOREMAN_VIEWS)
export type ForemanView = typeof ForemanView.Type

/** A task's pull request: what the merge waits for (`checks`, `you`, `github`), and a summary of its required checks. */
export const ForemanPullRequest = S.Struct({
  number: S.Int,
  url: S.String,
  state: S.Literals(["open", "merged", "closed"]),
  checks: S.OptionFromNullOr(S.Literals(["pending", "passing", "failing"])),
  waiting: S.OptionFromNullOr(S.Literals(["checks", "you", "github"])),
})
export type ForemanPullRequest = typeof ForemanPullRequest.Type

/** Where a task lives on the web: its page in its tracker, and its pull request. */
const ForemanLinks = {
  url: S.OptionFromNullOr(S.String),
  pr: S.OptionFromNullOr(ForemanPullRequest),
}

/** One task, workspace or account; `actions` are the subcommands `foreman <action> <key>` it takes. */
export const ForemanRow = S.Struct({
  view: ForemanView,
  key: S.String,
  label: S.String,
  detail: S.OptionFromNullOr(S.String),
  project: S.OptionFromNullOr(S.String),
  /** The epic the row's task sits under. */
  parent: S.OptionFromNullOr(S.String),
  /** An epic has no branch and no worker, so it takes no launch. */
  epic: S.Boolean,
  actions: S.Array(S.String),
  ...ForemanLinks,
})
export type ForemanRow = typeof ForemanRow.Type

export const FOREMAN_MODES = ["running", "paused", "idle"] as const

/**
 * What the dispatcher is doing: running, paused, idle (no step on and no
 * grant, so it only reads), or failed while the bridge starts it again.
 */
export const ForemanDispatcher = S.Union([
  S.Struct({ state: S.Literals(FOREMAN_MODES) }),
  S.Struct({ state: S.Literal("failed"), detail: S.String }),
])
export type ForemanDispatcher = typeof ForemanDispatcher.Type

/** The board's columns, left to right, as foreman names them. */
export const BOARD_COLUMNS = ["queue", "needs-you", "authoring", "review", "fixing", "landed"] as const
export const BoardColumn = S.Literals(BOARD_COLUMNS)
export type BoardColumn = typeof BoardColumn.Type

/** One task on the board, in the column foreman puts it in. */
export const ForemanPlacement = S.Struct({ key: S.String, label: S.String, project: S.String, column: BoardColumn, ...ForemanLinks })
export type ForemanPlacement = typeof ForemanPlacement.Type

/** One reading of the fleet, made by the dispatcher the bridge runs. */
export const ForemanReading = S.Struct({
  version: S.Literal(FOREMAN_VERSION),
  dispatcher: ForemanDispatcher,
  policy: ForemanPolicy,
  /** Why the policy file could not be read, which pauses the fleet. */
  policyError: S.OptionFromNullOr(S.String),
  /** ISO instant of the reading; none when the dispatcher failed before its first. */
  observedAt: S.OptionFromNullOr(S.String),
  /**
   * The managed projects; a board takes no drop where `grantSteps` (the steps a
   * grant gives) is empty. `tracker` keeps the project's tasks, `repo` is its
   * GitHub repo, and `unreachable` says why its tracker did not answer, which
   * holds the project.
   */
  projects: S.Array(
    S.Struct({
      name: S.String,
      grantSteps: S.Array(ForemanStep),
      tracker: S.Literals(["prog", "github", "linear"]),
      repo: S.OptionFromNullOr(S.String),
      unreachable: S.OptionFromNullOr(S.String),
    }),
  ),
  rows: S.Array(ForemanRow),
  /** Each task on the board; a landed one shows from `landed`. */
  placements: S.Array(ForemanPlacement),
  /** The projects whose pipeline cannot run, and why. */
  stopped: S.Array(S.Struct({ project: S.String, problems: S.Array(S.String) })),
  /** The board's Landed column: tasks that landed in the last day, newest first. */
  landed: S.Array(S.Struct({ key: S.String, label: S.String, project: S.String, landedAt: S.String })),
})
export type ForemanReading = typeof ForemanReading.Type

/** What the bridge knows of foreman: its dispatcher's last reading, none before the first. */
export const ForemanState = S.Struct({
  reading: S.OptionFromNullOr(ForemanReading),
  /** Why the last reading cannot be shown on this page. */
  problem: S.OptionFromNullOr(S.String),
})
export type ForemanState = typeof ForemanState.Type

/** The row actions the page can run: foreman's own, less the two that need a typed answer (`complete`, `intervene`). */
export const ForemanAction = S.Literals(["retry", "release", "close", "take-over", "focus", "kill", "descend", "unassign", "onboard", "adopt", "approve", "preview"])
export type ForemanAction = typeof ForemanAction.Type

/** The actions that end an agent or give up a claim. */
export const DESTRUCTIVE_ACTIONS: ReadonlyArray<ForemanAction> = ["kill", "close", "release"]

// A name goes to foreman as one argument. One that starts with a dash would be
// read as an option, so a name starts with a letter or digit.
export const ForemanName = S.String.check(S.isPattern(/^[A-Za-z0-9][\w.:@/-]*$/))

/** A role a rung may fill: writing a task's branch, or reading it. */
export const RungRole = S.Literals(["author", "review"])
export type RungRole = typeof RungRole.Type

export const ForemanCommand = S.Union([
  S.TaggedStruct("Act", { action: ForemanAction, key: ForemanName }),
  /** Starts a queued task on a picked rung; the operator's click is the permission, so the policy does not gate it. */
  S.TaggedStruct("Launch", { key: ForemanName, rung: ForemanName }),
  /**
   * Lets the fleet take steps beyond the default for one task, or every task
   * under an epic, as `foreman policy grant` does; `count` limits how many
   * tasks it covers, and absent means no limit.
   */
  S.TaggedStruct("Grant", { scope: ForemanName, steps: S.NonEmptyArray(ForemanStep), count: S.optional(S.Int.check(S.isGreaterThan(0))) }),
  S.TaggedStruct("Pause", {}),
  S.TaggedStruct("Resume", {}),
  S.TaggedStruct("SetStep", { step: ForemanStep, setting: ForemanStepMode }),
  S.TaggedStruct("SetSlots", { slots: S.Int.check(S.isGreaterThan(0)) }),
  S.TaggedStruct("Revoke", { scope: ForemanName }),
  /** Lets foreman dispatch a rung, or stops it; a disabled rung keeps its rank. */
  S.TaggedStruct("SetRung", { rung: ForemanName, on: S.Boolean }),
  /** Lets a rung fill a role, or keeps it out of that role. */
  S.TaggedStruct("SetRole", { rung: ForemanName, role: RungRole, on: S.Boolean }),
  /** Moves a rung to just above (dearer than) or just below (cheaper than) another. */
  S.TaggedStruct("MoveRung", { rung: ForemanName, side: S.Literals(["above", "below"]), of: ForemanName }),
])
export type ForemanCommand = typeof ForemanCommand.Type

/** The foreman command line that a command runs, less the program. */
export const argvOf = (command: ForemanCommand): ReadonlyArray<string> =>
  Match.valueTags(command, {
    Act: ({ action, key }) => [action, key],
    Launch: ({ key, rung }) => ["dispatch", key, "--rung", rung],
    Grant: ({ scope, steps, count }) => ["policy", "grant", scope, ...steps, ...(count === undefined ? [] : ["--count", String(count)])],
    Pause: () => ["policy", "pause"],
    Resume: () => ["policy", "resume"],
    SetStep: ({ step, setting }) => ["policy", "set", step, setting],
    SetSlots: ({ slots }) => ["policy", "slots", String(slots)],
    Revoke: ({ scope }) => ["policy", "revoke", scope],
    SetRung: ({ rung, on }) => ["ladder", on ? "enable" : "disable", rung],
    SetRole: ({ rung, role, on }) => ["ladder", "role", rung, role, on ? "on" : "off"],
    MoveRung: ({ rung, side, of }) => ["ladder", "move", rung, `--${side}`, of],
  })

/**
 * One rung of the ladder, cheapest first, as `foreman ladder list --json`
 * prints it. `state` is `disabled`, `retired`, or the model's record (`proven`,
 * `trial`); it stays a string so a state foreman adds later still reads.
 */
export const ForemanRung = S.Struct({
  rung: S.String,
  state: S.String,
  /** Whether foreman may give the rung authoring work, and review work. */
  author: S.Boolean,
  review: S.Boolean,
})
export type ForemanRung = typeof ForemanRung.Type

/** The rungs a queued task can be launched on: every one not disabled. */
export const launchableRungs = (rungs: ReadonlyArray<ForemanRung>): ReadonlyArray<string> =>
  rungs.flatMap(({ rung, state }) => (state === "disabled" ? [] : [rung]))
