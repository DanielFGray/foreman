// What foreman publishes about its fleet, and the commands the page may ask
// the bridge to run. The reading is a copy of foreman's own `Published`
// (src/published.ts there), version 2, holding the fields this page reads.
import { Match, Schema as S } from "effect"

/** The version of foreman's published shape this page reads. */
export const FOREMAN_VERSION = 2

export const FOREMAN_STEPS = ["author", "climb", "review", "land"] as const
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

/** Which steps the fleet takes by itself, and how many agents may work at once. */
export const ForemanPolicy = S.Struct({
  paused: S.Boolean,
  slots: S.Int,
  default: S.Struct({ author: S.Boolean, climb: S.Boolean, review: S.Boolean, land: S.Boolean }),
  grants: S.Array(ForemanGrant),
})
export type ForemanPolicy = typeof ForemanPolicy.Type

export const FOREMAN_VIEWS = ["attention", "working", "review", "queue", "quota", "landed"] as const
export const ForemanView = S.Literals(FOREMAN_VIEWS)
export type ForemanView = typeof ForemanView.Type

/** One task, workspace or account; `actions` are the subcommands `foreman <action> <key>` it takes. */
export const ForemanRow = S.Struct({
  view: ForemanView,
  key: S.String,
  label: S.String,
  detail: S.OptionFromNullOr(S.String),
  project: S.OptionFromNullOr(S.String),
  actions: S.Array(S.String),
})
export type ForemanRow = typeof ForemanRow.Type

/** One reading of the fleet: by the daemon after each pass, or by a one-shot `foreman status --json`. */
export const ForemanReading = S.Struct({
  daemon: S.Boolean,
  policy: ForemanPolicy,
  /** Why the policy file could not be read, which pauses the fleet. */
  policyError: S.OptionFromNullOr(S.String),
  /** ISO instant of the reading. */
  observedAt: S.OptionFromNullOr(S.String),
  projects: S.Array(S.Struct({ name: S.String, directory: S.String })),
  rows: S.Array(ForemanRow),
})
export type ForemanReading = typeof ForemanReading.Type

/**
 * What the bridge knows of foreman. The reading is the newest of the daemon's
 * file and the bridge's own one-shot readings, so a policy change shows with
 * no daemon running; whether one runs is told by `daemonAt` alone.
 */
export const ForemanState = S.Struct({
  reading: S.OptionFromNullOr(ForemanReading),
  /** When the daemon last published, epoch milliseconds; none when it never has. */
  daemonAt: S.OptionFromNullOr(S.Finite),
  /** Why the last reading failed. */
  problem: S.OptionFromNullOr(S.String),
  /** A one-shot reading is under way. */
  isReading: S.Boolean,
})
export type ForemanState = typeof ForemanState.Type

/** The row actions the page can run: foreman's own, less the two that need a typed answer (`complete`, `intervene`). */
export const ForemanAction = S.Literals(["retry", "release", "close", "take-over", "focus", "kill", "descend", "unassign", "onboard", "adopt"])
export type ForemanAction = typeof ForemanAction.Type

/** The actions that end an agent or give up a claim. */
export const DESTRUCTIVE_ACTIONS: ReadonlyArray<ForemanAction> = ["kill", "close", "release"]

// A name goes to foreman as one argument. One that starts with a dash would be
// read as an option, so a name starts with a letter or digit.
const Name = S.String.check(S.isPattern(/^[A-Za-z0-9][\w.:@/-]*$/))

export const ForemanCommand = S.Union([
  S.TaggedStruct("Act", { action: ForemanAction, key: Name }),
  /** Starts a queued task on a picked rung; the operator's click is the permission, so the policy does not gate it. */
  S.TaggedStruct("Launch", { key: Name, rung: Name }),
  /** Lets the fleet take one step for one task, once. */
  S.TaggedStruct("Allow", { key: Name, step: ForemanStep }),
  S.TaggedStruct("Pause", {}),
  S.TaggedStruct("Resume", {}),
  S.TaggedStruct("SetStep", { step: ForemanStep, on: S.Boolean }),
  S.TaggedStruct("SetSlots", { slots: S.Int.check(S.isGreaterThan(0)) }),
  S.TaggedStruct("Revoke", { scope: Name }),
])
export type ForemanCommand = typeof ForemanCommand.Type

/** The foreman command line that a command runs, less the program. */
export const argvOf = (command: ForemanCommand): ReadonlyArray<string> =>
  Match.valueTags(command, {
    Act: ({ action, key }) => [action, key],
    Launch: ({ key, rung }) => ["dispatch", key, "--rung", rung],
    Allow: ({ key, step }) => ["policy", "grant", key, step, "--count", "1"],
    Pause: () => ["policy", "pause"],
    Resume: () => ["policy", "resume"],
    SetStep: ({ step, on }) => ["policy", "set", step, on ? "on" : "off"],
    SetSlots: ({ slots }) => ["policy", "slots", String(slots)],
    Revoke: ({ scope }) => ["policy", "revoke", scope],
  })
