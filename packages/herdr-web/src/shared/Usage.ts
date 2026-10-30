// How much of each coding plan is used: one reading per provider, read by the
// bridge from the sign-in its agent keeps on disk.
import { Schema as S } from "effect"

/** A limit that resets: `used` is a percent, 0 to 100. Times are epoch milliseconds. */
export const UsageWindow = S.Struct({
  label: S.String,
  used: S.Finite,
  resetsAt: S.OptionFromNullOr(S.Finite),
  /** How long the window runs; with resetsAt it says how far through it is. */
  length: S.OptionFromNullOr(S.Finite),
})
export type UsageWindow = typeof UsageWindow.Type

export const UsageSection = S.Struct({
  title: S.String,
  facts: S.Array(S.Tuple([S.String, S.String])),
  windows: S.Array(UsageWindow),
})
export type UsageSection = typeof UsageSection.Type

export const UsageReport = S.Struct({
  plan: S.OptionFromNullOr(S.String),
  email: S.OptionFromNullOr(S.String),
  windows: S.Array(UsageWindow),
  sections: S.Array(UsageSection),
})
export type UsageReport = typeof UsageReport.Type

export const ProviderId = S.Literals(["claude", "codex", "opencode", "cursor"])
export type ProviderId = typeof ProviderId.Type

export const Reading = S.Struct({
  id: ProviderId,
  name: S.String,
  /** The provider's own usage page. */
  dashboard: S.String,
  /** None while signed out, or before the first good read. */
  report: S.OptionFromNullOr(UsageReport),
  updated: S.OptionFromNullOr(S.Finite),
  /** Why the last read failed; the report, if any, is then from an earlier read. */
  error: S.OptionFromNullOr(S.String),
  isReading: S.Boolean,
})
export type Reading = typeof Reading.Type

export const Usage = S.Struct({ readings: S.Array(Reading) })
export type Usage = typeof Usage.Type
