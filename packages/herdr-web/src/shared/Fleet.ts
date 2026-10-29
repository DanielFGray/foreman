// What the page shows: hc's terminals and herdr-app's spaces and tabs. The
// encoded side is hc's own wire shape (its OpenRPC `Terminal` and `Status`
// components, and the `herdr-app` document), so one Schema decodes hc's reply
// in the bridge and the bridge's message in the page.
import { Schema } from "effect"

/** What the program says it is doing (its OSC 7501 report). */
export const StatusState = Schema.Literals(["idle", "working", "done", "blocked", "error"])
export type StatusState = typeof StatusState.Type

export const Status = Schema.Struct({
  state: StatusState,
  app: Schema.OptionFromOptionalNullOr(Schema.String),
  msg: Schema.OptionFromOptionalNullOr(Schema.String),
  /** permission, question or auth: what a blocked program waits for. */
  kind: Schema.OptionFromOptionalNullOr(Schema.String),
  progress: Schema.OptionFromOptionalNullOr(Schema.Int),
})
export type Status = typeof Status.Type

export const Foreground = Schema.Struct({ name: Schema.String })

export const Terminal = Schema.Struct({
  /** `t7` here, `machine/t7` on a connected machine. */
  address: Schema.String,
  name: Schema.OptionFromOptionalNullOr(Schema.String),
  title: Schema.OptionFromOptionalNullOr(Schema.String),
  cwd: Schema.String,
  state: Schema.Literals(["live", "finished"]),
  status: Schema.OptionFromOptionalNullOr(Status),
  foreground: Schema.OptionFromOptionalNullOr(Foreground),
  /** herdr-app files a terminal under `herdr.space` and `herdr.tab`. */
  labels: Schema.Record(Schema.String, Schema.String),
  created_ms: Schema.Int,
})
export type Terminal = typeof Terminal.Type

export const Tab = Schema.Struct({ id: Schema.String, name: Schema.String })

export const Space = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  folder: Schema.String,
  tabs: Schema.Array(Tab),
})
export type Space = typeof Space.Type

/** The value of herdr-app's `herdr-app` document. */
export const HerdrAppDoc = Schema.Struct({ spaces: Schema.Array(Space) })

export const Fleet = Schema.Struct({
  /** False while the bridge has no live subscription to hc; the terminals are then the last ones seen. */
  connected: Schema.Boolean,
  terminals: Schema.Array(Terminal),
  spaces: Schema.Array(Space),
})
export type Fleet = typeof Fleet.Type
