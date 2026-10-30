// A live terminal in a pane: Ghostty's emulator, compiled to WebAssembly by
// ghostty-web, drawing the terminal's output to a canvas, and sending the keys
// typed into it. hc emulates its terminals as Ghostty too, so programs see
// the same terminal here as at the desk.
import { Effect, Inspectable, Match, Option, Queue, Ref, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import * as Mount from "foldkit/mount"
import { FitAddon, init, Terminal } from "ghostty-web"
import { applyModifiers, parseModifiersAttribute } from "./keys.ts"
import { watchLinks } from "./terminalLinks.ts"
import { BridgeClient, failureReason } from "./rpc.ts"
import { fontStack } from "./settings.ts"

const RECONNECT_DELAY = "2 seconds"
/** Lines the page keeps above the screen; hc paints up to 1000 of them on attach. */
const SCROLLBACK_LINES = 5000

/** The state of a pane's line to its terminal. */
export const Link = Schema.Union([
  Schema.TaggedStruct("Connecting", {}),
  Schema.TaggedStruct("Live", {}),
  Schema.TaggedStruct("Lost", { reason: Schema.String }),
])
export type Link = typeof Link.Type

export const ChangedLink = Schema.TaggedStruct("ChangedLink", { address: Schema.String, link: Link })

/** A tap, or a Ctrl or Cmd click, on a link in the terminal. */
export const PointedAtLink = Schema.TaggedStruct("PointedAtLink", { uri: Schema.String })

/** A key typed into the terminal took the armed soft modifiers. */
export const UsedModifiers = Schema.TaggedStruct("UsedModifiers", {})

/**
 * The soft modifiers armed for this terminal, as the view writes them: the
 * terminal reads them at each key typed, and reports when it uses them.
 */
export const MODIFIERS_ATTRIBUTE = "data-modifiers"

/** The emulator could not start in this browser. */
class NoEmulator extends Schema.TaggedError<NoEmulator, { readonly brand: unique symbol }>()("NoEmulator", {
  cause: Schema.Defect(),
}) {}

/**
 * Shows the terminal live in the element for as long as the element is on
 * the page. The page watches first, at the terminal's own size, so opening a
 * view leaves the size the program's viewers gave it. The first key typed
 * takes the terminal: the page attaches again as a typing viewer at the
 * element's size, and sends the key once that session is up. When the line
 * drops it attaches again: hc then paints the whole screen anew. A key typed
 * while soft modifiers are armed (MODIFIERS_ATTRIBUTE) goes out with them.
 */
export const LiveTerminal = Mount.defineStream("LiveTerminal", {
  args: { address: Schema.String, font: Schema.Option(Schema.String), size: Schema.Int },
  messages: [ChangedLink, UsedModifiers, PointedAtLink],
  execute: ({ element, address, font, size }) =>
    Stream.callback<typeof ChangedLink.Type | typeof UsedModifiers.Type | typeof PointedAtLink.Type>((messages) =>
      Effect.gen(function* () {
        const report = (link: Link) => Queue.offer(messages, ChangedLink.make({ address, link }))
        const { terminal, fit, page } = yield* openTerminal(element, font, size)
        yield* watchLinks(terminal, page, ({ uri }) => Queue.offer(messages, PointedAtLink.make({ uri })).pipe(Effect.asVoid))
        // Keys and sizes go out in the order they happen, to the session now attached.
        const outgoing = yield* Queue.unbounded<Outgoing>()
        const session = yield* Ref.make(Option.none<number>())
        const viewer = yield* SubscriptionRef.make<"Watching" | "Typing">("Watching")
        // The keys that take the terminal, until the typing session is up.
        const taking = yield* Ref.make(Option.none<ReadonlyArray<string>>())
        yield* Effect.acquireRelease(
          Effect.sync(() => [
            terminal.onData((data) => {
              const armed = parseModifiersAttribute(element.getAttribute(MODIFIERS_ATTRIBUTE) ?? "")
              Option.match(applyModifiers(data, armed), {
                onNone: () => Queue.offerUnsafe(outgoing, Typed.make({ data })),
                onSome: (modified) => {
                  Queue.offerUnsafe(outgoing, Typed.make({ data: modified }))
                  Queue.offerUnsafe(messages, UsedModifiers.make({}))
                },
              })
            }),
            terminal.onResize(({ cols, rows }) => Queue.offerUnsafe(outgoing, Resized.make({ cols, rows }))),
          ]),
          (listeners) => Effect.sync(() => listeners.forEach((listener) => listener.dispose())),
        )
        const client = yield* BridgeClient

        // The emulator takes the element's size, and keeps it from now on.
        const take = (data: string) =>
          Ref.set(taking, Option.some([data])).pipe(
            Effect.andThen(
              Effect.sync(() => {
                fit.fit()
                fit.observeResize()
              }),
            ),
            Effect.andThen(SubscriptionRef.set(viewer, "Typing")),
          )

        const typed = (data: string) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(session)
            const keys = yield* Ref.get(taking)
            return yield* Option.match(current, {
              onSome: (id) => client.input({ session: id, data }),
              onNone: () =>
                Option.match(keys, {
                  onSome: (sofar) => Ref.set(taking, Option.some([...sofar, data])),
                  // Keys typed while the line is down are lost; the pane says it is down.
                  onNone: () => Effect.flatMap(SubscriptionRef.get(viewer), (as) => (as === "Watching" ? take(data) : Effect.void)),
                }),
            })
          })

        yield* Stream.fromQueue(outgoing).pipe(
          Stream.runForEach((change) =>
            Match.valueTags(change, {
              Typed: ({ data }) => typed(data),
              // A watching page's size is the terminal's, and no one's to set.
              Resized: ({ cols, rows }) =>
                Effect.flatMap(Ref.get(session), Option.match({ onNone: () => Effect.void, onSome: (id) => client.resize({ session: id, cols, rows }) })),
            }).pipe(
              // A failed call means the line dropped; the attach below reports that.
              Effect.ignore,
            ),
          ),
          Effect.forkScoped,
        )

        const updates = (as: "Watching" | "Typing") =>
          client.attach({
            terminal: address,
            as: as === "Watching" ? { _tag: "Watching" } : { _tag: "Typing", cols: terminal.cols, rows: terminal.rows },
          })

        const attachOnce = (as: "Watching" | "Typing") =>
          report({ _tag: "Connecting" }).pipe(
            Effect.andThen(
              updates(as).pipe(
                Stream.runForEach((update) =>
                  Match.valueTags(update, {
                    // hc paints the whole screen after this, so the last line's screen goes.
                    Attached: ({ session: id }) =>
                      Effect.sync(() => terminal.reset()).pipe(
                        Effect.andThen(Ref.set(session, Option.some(id))),
                        Effect.andThen(report({ _tag: "Live" })),
                        Effect.andThen(Ref.getAndSet(taking, Option.none())),
                        Effect.flatMap((keys) => Effect.forEach(Option.getOrElse(keys, () => []), (data) => client.input({ session: id, data }).pipe(Effect.ignore))),
                      ),
                    Sized: ({ cols, rows }) =>
                      Effect.sync(() => {
                        terminal.reset()
                        terminal.resize(cols, rows)
                      }).pipe(Effect.andThen(report({ _tag: "Live" }))),
                    Output: ({ bytes }) => Effect.sync(() => terminal.write(bytes)),
                  }),
                ),
              ),
            ),
            Effect.matchEffect({
              onSuccess: () => report({ _tag: "Lost", reason: "the terminal closed" }),
              onFailure: (error) => report({ _tag: "Lost", reason: failureReason(error) }),
            }),
            Effect.ensuring(Ref.set(session, Option.none())),
            Effect.repeat(Schedule.spaced(RECONNECT_DELAY)),
          )

        // Taking the terminal ends the watch and starts the typing session.
        return yield* SubscriptionRef.changes(viewer).pipe(
          Stream.switchMap((as) => Stream.fromEffect(attachOnce(as))),
          Stream.runDrain,
        )
      }).pipe(
        Effect.catchTag("NoEmulator", ({ cause }) =>
          Queue.offer(messages, ChangedLink.make({ address, link: { _tag: "Lost", reason: `the terminal cannot start: ${Inspectable.toStringUnknown(cause, 0)}` } })),
        ),
        Effect.provide(BridgeClient.layer),
      ),
    ),
})

const Typed = Schema.TaggedStruct("Typed", { data: Schema.String })
const Resized = Schema.TaggedStruct("Resized", { cols: Schema.Int, rows: Schema.Int })
/** Fetches the chosen font from the bridge's /fonts.css; without it the terminal uses the fallback. */
const loadFont = (font: Option.Option<string>, size: number) =>
  Option.match(font, {
    onNone: () => Effect.void,
    onSome: (name) =>
      Effect.tryPromise(() => document.fonts.load(`${size}px ${JSON.stringify(name)}`)).pipe(
        Effect.catchTag("UnknownError", (error) => Effect.logWarning(`the font ${name} did not load`, error)),
      ),
  })

type Outgoing = typeof Typed.Type | typeof Resized.Type

// The emulator draws into the element. It takes the element's size only once
// the page types into the terminal; until then it takes the terminal's.
const openTerminal = (element: Element, font: Option.Option<string>, size: number) =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => init(), catch: (cause) => new NoEmulator({ cause }) }).pipe(
      // The emulator measures its cells once, so the font must be loaded first.
      Effect.andThen(loadFont(font, size)),
      Effect.andThen(
        Effect.sync(() => {
          const style = getComputedStyle(element)
          const color = (token: string) => style.getPropertyValue(token).trim()
          const terminal = new Terminal({
            fontFamily: fontStack("terminal", font),
            fontSize: size,
            scrollback: SCROLLBACK_LINES,
            theme: { background: color("--mantle"), foreground: color("--text"), cursor: color("--accent") },
          })
          const fit = new FitAddon()
          terminal.loadAddon(fit)
          return { terminal, fit }
        }),
      ),
      Effect.flatMap(({ terminal, fit }) =>
        element instanceof HTMLElement
          ? Effect.sync(() => {
              terminal.open(element)
              return { terminal, fit, page: element }
            })
          : Effect.fail(new NoEmulator({ cause: "the pane is not an HTML element" })),
      ),
    ),
    ({ terminal }) => Effect.sync(() => terminal.dispose()),
  )
