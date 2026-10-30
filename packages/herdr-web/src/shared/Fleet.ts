// What the page shows: hc's terminals and herdr-app's spaces and tabs. The
// encoded side is hc's own wire shape (its OpenRPC `Terminal` and `Status`
// components, and the `herdr-app` document), so one Schema decodes hc's reply
// in the bridge and the bridge's message in the page.
import { Effect, type Option, Schema } from "effect"
import { wireTag } from "./Wire.ts"

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

export const Foreground = Schema.Struct({
  name: Schema.String,
  pid: Schema.Int,
  /** The command line, program first; `bun test` tells a test run from another script. */
  argv: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
})

export const Terminal = Schema.Struct({
  /** `t7` here, `machine/t7` on a connected machine. */
  address: Schema.String,
  name: Schema.OptionFromOptionalNullOr(Schema.String),
  title: Schema.OptionFromOptionalNullOr(Schema.String),
  cwd: Schema.String,
  state: Schema.Literals(["live", "finished"]),
  status: Schema.OptionFromOptionalNullOr(Status),
  /** When `status` last changed, in milliseconds since the epoch. */
  status_ms: Schema.OptionFromOptionalNullOr(Schema.Int),
  foreground: Schema.OptionFromOptionalNullOr(Foreground),
  /** herdr-app files a terminal under `herdr.space` and `herdr.tab`. */
  labels: Schema.Record(Schema.String, Schema.String),
  created_ms: Schema.Int,
  /** The size in cells hc gives the program: the size of the viewer that typed last. */
  cols: Schema.Int,
  rows: Schema.Int,
  /** The terminal that started this one (`hc run` from inside its pane), addressed like `address`. */
  parent: Schema.OptionFromOptionalNullOr(Schema.String),
})
export type Terminal = typeof Terminal.Type

// LAYOUT
// herdr-app lays a tab out as a tree. A node it adds later, or a pane content
// the page does not know, decodes to a fallback variant instead of failing,
// so the rest of the fleet still shows.

/** A node's share of its parent along the split. herdr-app writes `{weight}`; any other form counts as an even share. */
export const Size = Schema.Struct({ weight: Schema.OptionFromOptionalKey(Schema.Finite) })
export type Size = typeof Size.Type

export const PaneContent = Schema.Union([
  Schema.Struct({ _tag: wireTag("Terminal"), terminal: Schema.String }),
  Schema.Struct({ _tag: wireTag("Mod"), mod: Schema.String }),
  Schema.Struct({ _tag: wireTag("Unknown") }),
])
export type PaneContent = typeof PaneContent.Type

export type Layout =
  | Readonly<{ _tag: "Block"; type: "block"; id: string; size: Option.Option<Size>; content: PaneContent }>
  /** `row` and `column`; a container of another type (a `stack`) keeps its children too. */
  | Readonly<{ _tag: "Split"; type: string; id: string; size: Option.Option<Size>; children: ReadonlyArray<Layout> }>
  | Readonly<{ _tag: "Unknown"; type: string }>

type LayoutEncoded =
  | Readonly<{ _tag?: "Block"; type: "block"; id: string; size?: typeof Size.Encoded; content: typeof PaneContent.Encoded }>
  | Readonly<{ _tag?: "Split"; type: string; id: string; size?: typeof Size.Encoded; children: ReadonlyArray<LayoutEncoded> }>
  | Readonly<{ _tag?: "Unknown"; type: string }>

const LayoutRef = Schema.suspend((): Schema.Codec<Layout, LayoutEncoded> => Layout)

export const Layout: Schema.Codec<Layout, LayoutEncoded> = Schema.Union([
  Schema.Struct({
    _tag: wireTag("Block"),
    type: Schema.Literal("block"),
    id: Schema.String,
    size: Schema.OptionFromOptionalKey(Size),
    content: PaneContent,
  }),
  Schema.Struct({
    _tag: wireTag("Split"),
    type: Schema.String,
    id: Schema.String,
    size: Schema.OptionFromOptionalKey(Size),
    children: Schema.Array(LayoutRef),
  }),
  Schema.Struct({ _tag: wireTag("Unknown"), type: Schema.String }),
])

export const Tab = Schema.Struct({ id: Schema.String, name: Schema.String, root: Layout })
export type Tab = typeof Tab.Type

export const Space = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  folder: Schema.String,
  tabs: Schema.Array(Tab),
})
export type Space = typeof Space.Type

/** The value of herdr-app's `herdr-app` document. */
export const HerdrAppDoc = Schema.Struct({ spaces: Schema.Array(Space) })

/** How hc reaches a machine. This machine is always connected. */
export const MachineState = Schema.Literals(["connecting", "connected", "needs_login", "unreachable"])
export type MachineState = typeof MachineState.Type

export const Machine = Schema.Struct({
  /** What hc calls it: `cynic` in `cynic/t7`. This machine's own name prefixes nothing. */
  name: Schema.String,
  isLocal: Schema.Boolean,
  state: MachineState,
  /**
   * Its herdr-app spaces. A space on another machine has its ids, and the
   * terminals in its layout, prefixed with the machine's name, as herdr-app
   * itself addresses them; while the machine is away they are the last seen.
   */
  spaces: Schema.Array(Space),
})
export type Machine = typeof Machine.Type

/** A space's folder as git sees it. `branch` is none for a detached head. */
export const SpaceGit = Schema.Struct({ branch: Schema.OptionFromNullOr(Schema.String), changed: Schema.Boolean })
export type SpaceGit = typeof SpaceGit.Type

export const Fleet = Schema.Struct({
  /** False while the bridge has no live subscription to hc; the terminals are then the last ones seen. */
  connected: Schema.Boolean,
  /** Every connected machine's terminals, addressed `machine/t7` on another machine. */
  terminals: Schema.Array(Terminal),
  /** This machine first, then the others in hc's order. */
  machines: Schema.Array(Machine),
  /**
   * Git state by space id (machine-prefixed on another machine). A space with
   * no entry has none: its folder is no repository, git is missing, or its
   * machine is away.
   */
  git: Schema.Record(Schema.String, SpaceGit),
})
export type Fleet = typeof Fleet.Type
