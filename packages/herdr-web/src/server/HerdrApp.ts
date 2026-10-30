// herdr-app's layout commands, done by the bridge itself: it edits the layout
// document through hc, as the herdr-app window does, so they work with the
// window open or closed. An open window reads the document again on each change.
//
// The page addresses a space, tab or pane on another machine as `machine/id`,
// as herdr-app does; that machine's document holds the bare id.
import { Array, Config, Context, Effect, HashSet, Layer, Option, Schema as S, String } from "effect"
import type { HcFailure } from "../hc/Connection.ts"
import { Hc } from "../hc/Hc.ts"
import { closePane, closeSpace, closeTab, findTab, freshId, type LayoutDoc, moveSpace, newSpace, newTab, renameSpace, split, terminalOf } from "../hc/LayoutDoc.ts"
import type { Direction } from "../shared/Api.ts"
import type { Terminal } from "../shared/Fleet.ts"
import { FleetModel } from "./FleetModel.ts"

/** The layout has no such space, tab or pane, or herdr-app keeps it. */
export class HerdrAppError extends S.TaggedError<HerdrAppError, { readonly brand: unique symbol }>()("HerdrAppError", {
  message: S.String,
}) {}

export class HerdrApp extends Context.Service<HerdrApp>()("herdr-web/server/HerdrApp", {
  make: Effect.gen(function* () {
    const hc = yield* Hc
    const fleet = yield* FleetModel

    // Reads the machine's layout, changes it, and writes it at the version
    // read; when the window or another page wrote in between, reads it again.
    const edit = <A>(on: Option.Option<string>, missing: string, change: (doc: LayoutDoc) => Option.Option<readonly [LayoutDoc, A]>) =>
      hc.layout(on).pipe(
        Effect.flatMap(({ doc, version }) =>
          Effect.fromOption(change(doc)).pipe(
            Effect.mapError(() => new HerdrAppError({ message: missing })),
            Effect.flatMap(([next, result]) => Effect.as(hc.setLayout(on, next, version), result)),
          ),
        ),
        Effect.retry({ while: isConflict, times: CONFLICT_RETRIES }),
      )

    // A program started from a pane goes with it, unless it holds a pane of
    // its own (herdr-app labels those with their space).
    const killed = (terminals: ReadonlyArray<string>) =>
      Effect.flatMap(fleet.get, ({ terminals: known }) =>
        Effect.forEach(doomed(known, terminals), endTerminal, { discard: true }),
      )

    // The layout no longer shows it, so a terminal that will not end is only logged.
    const endTerminal = (terminal: string) =>
      hc.kill(terminal).pipe(Effect.catch((error) => Effect.logWarning(`cannot end terminal ${terminal}`, error)))

    // Without SHELL (a bare service manager) a program still starts, in sh.
    const loginShell = yield* Config.String("SHELL").pipe(Config.withDefault("sh"))
    const home = yield* Config.String("HOME")

    // A new pane's program, labelled with its space and tab as herdr-app labels them.
    const start = (on: Option.Option<string>, argv: ReadonlyArray<string>, cwd: string, space: string, tab: string) =>
      hc.start({ argv, cwd, labels: { "herdr.space": space, "herdr.tab": tab }, on })

    const shell = (on: Option.Option<string>, cwd: string, space: string, tab: string) =>
      Effect.map(start(on, [], cwd, space, tab), ({ address }) => address)

    return {
      /** Opens a shell beside the pane, in the folder of the pane's terminal, else of its space. */
      split: (pane: string, direction: Direction) =>
        Effect.gen(function* () {
          const { on, id } = localOf(pane)
          const { doc } = yield* hc.layout(on)
          const { space, tab } = yield* Effect.fromOption(findTab(doc, id)).pipe(Effect.mapError(() => new HerdrAppError({ message: `no pane ${pane}` })))
          const cwd = yield* Option.match(terminalOf(doc, id), {
            onNone: () => Effect.succeed(space.folder),
            // A terminal hc no longer has opens the shell in the space's folder.
            onSome: (terminal) => hc.get(qualified(on, terminal)).pipe(Effect.map(({ cwd }) => cwd), Effect.catchTag("HcError", () => Effect.succeed(space.folder))),
          })
          const terminal = yield* shell(on, cwd, space.id, tab.id)
          yield* edit(on, `no pane ${pane}`, (now) =>
            Option.map(split(now, { pane: id, direction, newPane: freshId("p"), container: freshId("s"), terminal: localOf(terminal).id }), (next) => [next, undefined] as const),
          ).pipe(Effect.tapError(() => endTerminal(terminal)))
          return { terminal }
        }),
      /** Closes the pane and ends its terminal; a tab's last pane closes the tab. */
      close: (pane: string) => {
        const { on, id } = localOf(pane)
        return edit(on, `herdr-app keeps pane ${pane}: it is not closable, or the last of its space`, (doc) =>
          Option.map(closePane(doc, id), (closed) => [closed.doc, closed.terminals] as const),
        ).pipe(Effect.flatMap((terminals) => killed(Array.map(terminals, (terminal) => qualified(on, terminal)))))
      },
      /** Opens a tab with a shell in the space's folder; the tab and its terminal. */
      newTab: (space: string) =>
        Effect.gen(function* () {
          const { on, id } = localOf(space)
          const { doc } = yield* hc.layout(on)
          const folder = yield* Effect.fromOption(Option.map(Array.findFirst(doc.spaces, (one) => one.id === id), ({ folder }) => folder)).pipe(
            Effect.mapError(() => new HerdrAppError({ message: `no space ${space}` })),
          )
          const tab = freshId("tb")
          const terminal = yield* shell(on, folder, id, tab)
          yield* edit(on, `no space ${space}`, (now) =>
            Option.map(newTab(now, { space: id, tab, pane: freshId("p"), terminal: localOf(terminal).id }), (next) => [next, undefined] as const),
          ).pipe(Effect.tapError(() => endTerminal(terminal)))
          return { tab: qualified(on, tab), terminal }
        }),
      /** Closes the tab and ends its terminals. */
      closeTab: (tab: string) => {
        const { on, id } = localOf(tab)
        return edit(on, `herdr-app keeps tab ${tab}: it is the last of its space`, (doc) =>
          Option.map(closeTab(doc, id), (closed) => [closed.doc, closed.terminals] as const),
        ).pipe(Effect.flatMap((terminals) => killed(Array.map(terminals, (terminal) => qualified(on, terminal)))))
      },
      /**
       * Opens a space on the machine `on` (none for this one) with one tab,
       * whose pane runs `program` and then the shell, or the shell alone. The
       * folder is absolute, or relative to that machine's home; the space
       * keeps the folder the program started in.
       */
      newSpace: (at: Readonly<{ on: Option.Option<string>; folder: string; name: string; program: Option.Option<string> }>) =>
        Effect.gen(function* () {
          const [space, tab] = [freshId("sp"), freshId("tb")]
          const argv = Option.match(Option.filter(Option.map(at.program, String.trim), String.isNonEmpty), {
            onNone: () => [],
            onSome: (line) => withShellAfter(at.on, loginShell, String.split(line, /\s+/)),
          })
          const started = yield* start(at.on, argv, folderOn(at.on, home, at.folder), space, tab)
          yield* edit(at.on, "cannot add the space", (doc) =>
            Option.some([newSpace(doc, { space, name: at.name, folder: started.cwd, tab, pane: freshId("p"), terminal: localOf(started.address).id }), undefined] as const),
          ).pipe(Effect.tapError(() => endTerminal(started.address)))
          return { tab: qualified(at.on, tab), terminal: started.address }
        }),
      /** Names the space; an empty name shows it by its folder. */
      renameSpace: (space: string, name: string) => {
        const { on, id } = localOf(space)
        return edit(on, `no space ${space}`, (doc) => Option.map(renameSpace(doc, id, name), (next) => [next, undefined] as const))
      },
      /** Closes the space and ends the terminals of all its tabs. The page asks the user first. */
      closeSpace: (space: string) => {
        const { on, id } = localOf(space)
        return edit(on, `no space ${space}`, (doc) => Option.map(closeSpace(doc, id), (closed) => [closed.doc, closed.terminals] as const)).pipe(
          Effect.flatMap((terminals) => killed(Array.map(terminals, (terminal) => qualified(on, terminal)))),
        )
      },
      /**
       * Moves the space to where `onto` is now, as a drag in herdr-app's own
       * sidebar does: after it when moving down, before it when moving up.
       * Each machine keeps its own spaces, so both must be on one machine.
       */
      moveSpace: (space: string, onto: string) => {
        const [from, to] = [localOf(space), localOf(onto)]
        return Option.makeEquivalence(String.Equivalence)(from.on, to.on)
          ? edit(from.on, `no space ${space} or ${onto}`, (doc) => Option.map(moveSpace(doc, from.id, to.id), (next) => [next, undefined] as const))
          : Effect.fail(new HerdrAppError({ message: `${space} and ${onto} are on different machines` }))
      },
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

/** How many times an edit reads the layout again after another write came first. */
const CONFLICT_RETRIES = 5

const isConflict = (error: HcFailure | HerdrAppError) => error._tag === "HcError" && error.kind === "conflict"

/** The machine an id is on, none for this one, and the id its machine's document holds. */
export const localOf = (address: string) =>
  Option.match(String.indexOf("/")(address), {
    onNone: () => ({ on: Option.none<string>(), id: address }),
    onSome: (at) => ({ on: Option.some(address.slice(0, at)), id: address.slice(at + 1) }),
  })

export const qualified = (on: Option.Option<string>, id: string) => Option.match(on, { onNone: () => id, onSome: (machine) => `${machine}/${id}` })

/**
 * The terminals that end with `closed`: those, and every terminal started
 * from one of them, down the chain, that holds no pane of its own.
 */
export const doomed = (terminals: ReadonlyArray<Terminal>, closed: ReadonlyArray<string>): ReadonlyArray<string> => {
  const grow = (sofar: HashSet.HashSet<string>): HashSet.HashSet<string> => {
    const more = Array.filter(
      terminals,
      ({ address, parent, labels }) =>
        !HashSet.has(sofar, address) && Option.exists(parent, (from) => HashSet.has(sofar, from)) && String.isEmpty(labels["herdr.space"] ?? ""),
    )
    return Array.isReadonlyArrayEmpty(more) ? sofar : grow(HashSet.union(sofar, HashSet.fromIterable(Array.map(more, ({ address }) => address))))
  }
  return Array.fromIterable(grow(HashSet.fromIterable(closed)))
}

/**
 * A program's argv that leaves the user in a shell when the program ends, as
 * herdr-app starts one. Here the user's login shell runs it, so its startup
 * files set the PATH; on another machine, whose shell the bridge does not
 * know, sh runs it and then that machine's $SHELL.
 */
export const withShellAfter = (on: Option.Option<string>, loginShell: string, program: ReadonlyArray<string>): ReadonlyArray<string> =>
  Option.isSome(on)
    ? ["sh", "-c", '"$@"; exec "${SHELL:-sh}" -i', "sh", ...program]
    : [loginShell, "-ic", Option.contains(Array.last(String.split(loginShell, "/")), "fish") ? "command $argv[2..]; exec $argv[1] -i" : '"$@"; exec "$0" -i', loginShell, ...program]

/**
 * Where a new space starts. hc starts a terminal on another machine relative
 * to that machine's home, and here relative to its own folder, so here a
 * relative folder is taken from the home first. `~` means the home on either.
 */
export const folderOn = (on: Option.Option<string>, home: string, folder: string): string => {
  const relative = folder.replace(/^~(\/|$)/, "")
  return relative.startsWith("/") || Option.isSome(on) ? relative : relative === "" ? home : `${home}/${relative}`
}
