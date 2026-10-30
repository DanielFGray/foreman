// How much of each coding plan is used: one reading per provider, read by the
// bridge from the sign-in its agent keeps on disk.
import { Schema } from "effect"

/** A limit that resets: `used` is a percent, 0 to 100. Times are epoch milliseconds. */
export const UsageWindow = Schema.Struct({
  label: Schema.String,
  used: Schema.Finite,
  resetsAt: Schema.OptionFromNullOr(Schema.Finite),
  /** How long the window runs; with resetsAt it says how far through it is. */
  length: Schema.OptionFromNullOr(Schema.Finite),
})
export type UsageWindow = typeof UsageWindow.Type

export const UsageSection = Schema.Struct({
  title: Schema.String,
  facts: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  windows: Schema.Array(UsageWindow),
})
export type UsageSection = typeof UsageSection.Type

export const UsageReport = Schema.Struct({
  plan: Schema.OptionFromNullOr(Schema.String),
  email: Schema.OptionFromNullOr(Schema.String),
  windows: Schema.Array(UsageWindow),
  sections: Schema.Array(UsageSection),
})
export type UsageReport = typeof UsageReport.Type

export const ProviderId = Schema.Literals(["claude", "codex", "opencode", "cursor"])
export type ProviderId = typeof ProviderId.Type

export const Reading = Schema.Struct({
  id: ProviderId,
  name: Schema.String,
  /** The provider's own usage page. */
  dashboard: Schema.String,
  /** None while signed out, or before the first good read. */
  report: Schema.OptionFromNullOr(UsageReport),
  updated: Schema.OptionFromNullOr(Schema.Finite),
  /** Why the last read failed; the report, if any, is then from an earlier read. */
  error: Schema.OptionFromNullOr(Schema.String),
  isReading: Schema.Boolean,
})
export type Reading = typeof Reading.Type

export const Usage = Schema.Struct({ readings: Schema.Array(Reading) })
export type Usage = typeof Usage.Type
