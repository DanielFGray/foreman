// A live terminal in a pane: Ghostty's emulator, compiled to WebAssembly by
// ghostty-web, drawing the terminal's output to a canvas, and sending the keys
// typed into it. hc emulates its terminals as Ghostty too, so programs see
// the same terminal here as at the desk.
import { Effect, Inspectable, Match, Option, Queue, Ref, Schedule, Schema, Stream } from "effect"
import * as Mount from "foldkit/mount"
import { FitAddon, init, Terminal } from "ghostty-web"
import { BridgeClient, failureReason } from "./rpc.ts"

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

/** The emulator could not start in this browser. */
class NoEmulator extends Schema.TaggedError<NoEmulator, { readonly brand: unique symbol }>()("NoEmulator", {
  cause: Schema.Defect(),
}) {}

/**
 * Shows the terminal live in the element, at the element's size, for as long
 * as the element is on the page. When the line drops it attaches again: hc
 * then paints the whole screen anew.
 */
export const LiveTerminal = Mount.defineStream("LiveTerminal", {
  args: { address: Schema.String },
  messages: [ChangedLink],
  execute: ({ element, address }) =>
    Stream.callback<typeof ChangedLink.Type>((links) =>
      Effect.gen(function* () {
        const report = (link: Link) => Queue.offer(links, ChangedLink.make({ address, link }))
        const terminal = yield* openTerminal(element)
        // Keys and sizes go out in the order they happen, to the session now attached.
        const outgoing = yield* Queue.unbounded<Outgoing>()
        const session = yield* Ref.make(Option.none<number>())
        yield* Effect.acquireRelease(
          Effect.sync(() => [
            terminal.onData((data) => Queue.offerUnsafe(outgoing, Typed.make({ data }))),
            terminal.onResize(({ cols, rows }) => Queue.offerUnsafe(outgoing, Resized.make({ cols, rows }))),
          ]),
          (listeners) => Effect.sync(() => listeners.forEach((listener) => listener.dispose())),
        )
        const client = yield* BridgeClient

        yield* Stream.fromQueue(outgoing).pipe(
          Stream.runForEach((change) =>
            Ref.get(session).pipe(
              Effect.flatMap(
                Option.match({
                  // Keys typed while the line is down are lost; the pane says it is down.
                  onNone: () => Effect.void,
                  onSome: (id) =>
                    Match.valueTags(change, {
                      Typed: ({ data }) => client.input({ session: id, data }),
                      Resized: ({ cols, rows }) => client.resize({ session: id, cols, rows }),
                    }),
                }),
              ),
              // A failed call means the line dropped; the attach below reports that.
              Effect.ignore,
            ),
          ),
          Effect.forkScoped,
        )

        const attachOnce = report({ _tag: "Connecting" }).pipe(
          Effect.andThen(
            client.attach({ terminal: address, cols: terminal.cols, rows: terminal.rows }).pipe(
              Stream.runForEach((update) =>
                Match.valueTags(update, {
                  // hc paints the whole screen after this, so the last line's screen goes.
                  Attached: ({ session: id }) =>
                    Effect.sync(() => terminal.reset()).pipe(
                      Effect.andThen(Ref.set(session, Option.some(id))),
                      Effect.andThen(report({ _tag: "Live" })),
                    ),
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
        )
        return yield* attachOnce.pipe(Effect.repeat(Schedule.spaced(RECONNECT_DELAY)))
      }).pipe(
        Effect.catchTag("NoEmulator", ({ cause }) =>
          Queue.offer(links, ChangedLink.make({ address, link: { _tag: "Lost", reason: `the terminal cannot start: ${Inspectable.toStringUnknown(cause, 0)}` } })),
        ),
        Effect.provide(BridgeClient.layer),
      ),
    ),
})

const Typed = Schema.TaggedStruct("Typed", { data: Schema.String })
const Resized = Schema.TaggedStruct("Resized", { cols: Schema.Int, rows: Schema.Int })
type Outgoing = typeof Typed.Type | typeof Resized.Type

// The emulator draws into the element and keeps itself at the element's size.
const openTerminal = (element: Element) =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => init(), catch: (cause) => new NoEmulator({ cause }) }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const style = getComputedStyle(element)
          const color = (token: string) => style.getPropertyValue(token).trim()
          const terminal = new Terminal({
            fontFamily: "ui-monospace, monospace",
            fontSize: 13,
            scrollback: SCROLLBACK_LINES,
            theme: { background: color("--mantle"), foreground: color("--text"), cursor: color("--accent") },
          })
          const fit = new FitAddon()
          terminal.loadAddon(fit)
          return { terminal, fit }
        }),
      ),
      Effect.tap(({ terminal, fit }) =>
        element instanceof HTMLElement
          ? Effect.sync(() => {
              terminal.open(element)
              fit.fit()
              fit.observeResize()
            })
          : Effect.fail(new NoEmulator({ cause: "the pane is not an HTML element" })),
      ),
    ),
    ({ terminal }) => Effect.sync(() => terminal.dispose()),
  ).pipe(Effect.map(({ terminal }) => terminal))
