// What the page shows: hc's terminals and herdr-app's spaces and tabs. The
// encoded side is hc's own wire shape (its OpenRPC `Terminal` and `Status`
// components, and the `herdr-app` document), so one Schema decodes hc's reply
// in the bridge and the bridge's message in the page.
import { Array, Effect, Match, Option, pipe, Schema as S } from "effect"
import { wireTag } from "./Wire.ts"

/** What the program says it is doing (its OSC 7501 report). */
export const StatusState = S.Literals(["idle", "working", "done", "blocked", "error"])
export type StatusState = typeof StatusState.Type

export const Status = S.Struct({
  state: StatusState,
  app: S.OptionFromOptionalNullOr(S.String),
  msg: S.OptionFromOptionalNullOr(S.String),
  /** permission, question or auth: what a blocked program waits for. */
  kind: S.OptionFromOptionalNullOr(S.String),
  progress: S.OptionFromOptionalNullOr(S.Int),
})
export type Status = typeof Status.Type

export const Foreground = S.Struct({
  name: S.String,
  pid: S.Int,
  /** The command line, program first; `bun test` tells a test run from another script. */
  argv: S.Array(S.String).pipe(S.withDecodingDefaultKey(Effect.succeed([]))),
  /** Its working folder now, as the OS has it. */
  cwd: S.String,
})

export const Terminal = S.Struct({
  /** `t7` here, `machine/t7` on a connected machine. */
  address: S.String,
  name: S.OptionFromOptionalNullOr(S.String),
  title: S.OptionFromOptionalNullOr(S.String),
  cwd: S.String,
  state: S.Literals(["live", "finished"]),
  status: S.OptionFromOptionalNullOr(Status),
  /** The program's other 7501 reports, by their record id, for programs that report on several things at once. */
  records: S.OptionFromOptionalNullOr(S.Record(S.String, Status)),
  /** When `status` last changed, in milliseconds since the epoch. */
  status_ms: S.OptionFromOptionalNullOr(S.Int),
  foreground: S.OptionFromOptionalNullOr(Foreground),
  /** herdr-app files a terminal under `herdr.space` and `herdr.tab`. */
  labels: S.Record(S.String, S.String),
  created_ms: S.Int,
  /** The size in cells hc gives the program: the size of the viewer that typed last. */
  cols: S.Int,
  rows: S.Int,
  /** The terminal that started this one (`hc run` from inside its pane), addressed like `address`. */
  parent: S.OptionFromOptionalNullOr(S.String),
})
export type Terminal = typeof Terminal.Type

// LAYOUT
// herdr-app lays a tab out as a tree. A node it adds later, or a pane content
// the page does not know, decodes to a fallback variant instead of failing,
// so the rest of the fleet still shows.

/** A node's share of its parent along the split. herdr-app writes `{weight}`; any other form counts as an even share. */
export const Size = S.Struct({ weight: S.OptionFromOptionalKey(S.Finite) })
export type Size = typeof Size.Type

export const PaneContent = S.Union([
  S.Struct({ _tag: wireTag("Terminal"), terminal: S.String }),
  S.Struct({ _tag: wireTag("Mod"), mod: S.String }),
  S.Struct({ _tag: wireTag("Unknown") }),
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

const LayoutRef = S.suspend((): S.Codec<Layout, LayoutEncoded> => Layout)

export const Layout: S.Codec<Layout, LayoutEncoded> = S.Union([
  S.Struct({
    _tag: wireTag("Block"),
    type: S.Literal("block"),
    id: S.String,
    size: S.OptionFromOptionalKey(Size),
    content: PaneContent,
  }),
  S.Struct({
    _tag: wireTag("Split"),
    type: S.String,
    id: S.String,
    size: S.OptionFromOptionalKey(Size),
    children: S.Array(LayoutRef),
  }),
  S.Struct({ _tag: wireTag("Unknown"), type: S.String }),
])

export const Tab = S.Struct({ id: S.String, name: S.String, root: Layout })
export type Tab = typeof Tab.Type

export const Space = S.Struct({
  id: S.String,
  name: S.String,
  folder: S.String,
  tabs: S.Array(Tab),
})
export type Space = typeof Space.Type

/** How hc reaches a machine. This machine is always connected. */
export const MachineState = S.Literals(["connecting", "connected", "needs_login", "unreachable"])
export type MachineState = typeof MachineState.Type

export const Machine = S.Struct({
  /** What hc calls it: `cynic` in `cynic/t7`. This machine's own name prefixes nothing. */
  name: S.String,
  isLocal: S.Boolean,
  state: MachineState,
  /**
   * Its herdr-app spaces. A space on another machine has its ids, and the
   * terminals in its layout, prefixed with the machine's name, as herdr-app
   * itself addresses them; while the machine is away they are the last seen.
   */
  spaces: S.Array(Space),
})
export type Machine = typeof Machine.Type

/**
 * The git state of the folder a space works in now (see folderNow). `top` is
 * the checkout that holds it, a worktree's own folder; `branch` is none for a
 * detached head. `project` is the prog project the folder's repository is,
 * none when git cannot say.
 */
export const SpaceGit = S.Struct({ top: S.String, branch: S.OptionFromNullOr(S.String), changed: S.Boolean, project: S.OptionFromNullOr(S.String) })
export type SpaceGit = typeof SpaceGit.Type

export const Fleet = S.Struct({
  /** False while the bridge has no live subscription to hc; the terminals are then the last ones seen. */
  connected: S.Boolean,
  /** Every connected machine's terminals, addressed `machine/t7` on another machine. */
  terminals: S.Array(Terminal),
  /** This machine first, then the others in hc's order. */
  machines: S.Array(Machine),
  /**
   * Git state by space id (machine-prefixed on another machine). A space with
   * no entry has none: its folder is no repository, git is missing, or its
   * machine is away.
   */
  git: S.Record(S.String, SpaceGit),
})
export type Fleet = typeof Fleet.Type

/** The terminals a layout shows, in reading order. */
export const terminalsIn = (node: Layout): ReadonlyArray<string> =>
  Match.valueTags(node, {
    Block: ({ content }) => (content._tag === "Terminal" ? [content.terminal] : []),
    Split: ({ children }) => Array.flatMap(children, terminalsIn),
    Unknown: () => [],
  })

/**
 * The folder a space works in now: its first terminal's program's folder,
 * else that terminal's own, else the folder the space was made in. herdr-app
 * names an unnamed space after it, so a space follows its agent to another
 * folder; the bridge reads the space's git state there.
 */
export const folderNow = (terminals: ReadonlyArray<Terminal>, space: Space) =>
  pipe(
    Array.head(Array.flatMap(space.tabs, ({ root }) => terminalsIn(root))),
    Option.flatMap((address) => Array.findFirst(terminals, (terminal) => terminal.address === address)),
    Option.map(({ foreground, cwd }) => Option.match(foreground, { onNone: () => cwd, onSome: (program) => program.cwd })),
    Option.getOrElse(() => space.folder),
  )
