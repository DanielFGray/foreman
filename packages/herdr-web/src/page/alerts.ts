// Push alerts on this device, from the browser's side: whether the browser can
// have them, its subscription, which the bridge sends alerts to, and the
// service worker (public/sw.js) that shows them. The browser keeps the
// subscription, so the page asks the browser whether alerts are on rather
// than keeping its own record. The page also tells the bridge while it is in
// front and focused, and opens the terminal of an alert that was tapped.
import { Effect, Match, Option, Schedule, Schema as S, Stream } from "effect"
import { Command } from "foldkit"
import * as Dom from "foldkit/dom"
import type { RpcClientError } from "effect/rpc"
import type { BridgeError } from "../shared/Api.ts"
import { AlertEvent, PushSubscription } from "../shared/Push.ts"
import { Alerts, Message } from "./model.ts"
import { BridgeClient, failureReason } from "./rpc.ts"

/**
 * Reads whether this device has alerts, and sends its subscription to the
 * bridge again, so the bridge's copy has the device's events and survives a
 * lost file.
 */
export const CheckAlerts = Command.define("CheckAlerts", {
  args: { events: S.Array(AlertEvent) },
  messages: [Message.GotAlerts],
  execute: ({ events }) =>
    Option.match(unavailable(), {
      onSome: (reason) => Effect.succeed(got(Alerts.Unavailable({ reason }))),
      onNone: () =>
        Notification.permission === "denied"
          ? Effect.succeed(got(Alerts.Blocked()))
          : current.pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(got(Alerts.Off())),
                  onSome: (subscription) =>
                    subscribe(subscription, events).pipe(
                      Effect.as(got(Alerts.On({ subscription }))),
                      Effect.catch((error) => Effect.succeed(noted(Alerts.On({ subscription }), reasonOf(error)))),
                    ),
                }),
              ),
              Effect.catch((error) => Effect.succeed(noted(Alerts.Off(), reasonOf(error)))),
            ),
    }),
})

/** Asks the person's permission, subscribes this device with the bridge's key, and gives the subscription to the bridge. */
export const TurnAlertsOn = Command.define("TurnAlertsOn", {
  args: { events: S.Array(AlertEvent) },
  messages: [Message.GotAlerts],
  execute: ({ events }) =>
    Effect.gen(function* () {
      const permission = yield* browser("did not ask for permission", () => Notification.requestPermission())
      if (permission === "denied") {
        return got(Alerts.Blocked())
      }
      if (permission !== "granted") {
        return noted(Alerts.Off(), "alerts need your permission")
      }
      const client = yield* BridgeClient
      const applicationServerKey = yield* Effect.flatMap(client.pushKey(), S.decodeEffect(S.Uint8ArrayFromBase64Url)).pipe(
        Effect.catchTag("SchemaError", () => new BrowserRefused({ message: "the bridge's push key does not decode" })),
      )
      yield* browser("did not start the alert worker", () => navigator.serviceWorker.register("/sw.js"))
      const registration = yield* browser("did not start the alert worker", () => navigator.serviceWorker.ready)
      const made = yield* browser("refused to subscribe", () => registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array(applicationServerKey) }))
      const subscription = yield* decoded(made)
      yield* subscribe(subscription, events)
      return got(Alerts.On({ subscription }))
    }).pipe(Effect.catch((error) => Effect.succeed(noted(Alerts.Off(), reasonOf(error))))),
})

export const TurnAlertsOff = Command.define("TurnAlertsOff", {
  args: { subscription: PushSubscription },
  messages: [Message.GotAlerts],
  execute: ({ subscription }) =>
    Effect.gen(function* () {
      const live = yield* browserSubscription
      yield* Option.match(live, { onNone: () => Effect.void, onSome: (found) => browser("did not unsubscribe", () => found.unsubscribe()) })
      const client = yield* BridgeClient
      yield* client.unsubscribePush({ endpoint: subscription.endpoint })
      return got(Alerts.Off())
    }).pipe(Effect.catch((error) => Effect.succeed(noted(Alerts.On({ subscription }), reasonOf(error))))),
})

export const SendTestAlert = Command.define("SendTestAlert", {
  args: { subscription: PushSubscription },
  messages: [Message.NotedAlerts],
  execute: ({ subscription }) =>
    Effect.flatMap(BridgeClient, (client) => client.testPush({ subscription })).pipe(
      Effect.as(Message.NotedAlerts({ note: "A test alert is on its way." })),
      Effect.catch((error) => Effect.succeed(Message.NotedAlerts({ note: reasonOf(error) }))),
    ),
})

/** Gives the bridge this device's new events. */
export const SyncAlerts = Command.define("SyncAlerts", {
  args: { subscription: PushSubscription, events: S.Array(AlertEvent) },
  messages: [Message.NotedAlerts],
  execute: ({ subscription, events }) =>
    subscribe(subscription, events).pipe(
      Effect.as(Message.NotedAlerts({ note: "This device gets the alerts picked." })),
      Effect.catch((error) => Effect.succeed(Message.NotedAlerts({ note: reasonOf(error) }))),
    ),
})

/**
 * Holds the bridge's `present` stream open while this page is visible and
 * focused, so no alert goes out while someone looks at it. Emits nothing.
 */
export const presence = Effect.gen(function* () {
  const client = yield* BridgeClient
  const isPresent = () => document.visibilityState === "visible" && document.hasFocus()
  const changes = Stream.mergeAll(
    [
      Dom.streamFromEvent({ target: window, type: "focus", mapEvent: isPresent }),
      Dom.streamFromEvent({ target: window, type: "blur", mapEvent: isPresent }),
      Dom.streamFromEvent({ target: document, type: "visibilitychange", mapEvent: isPresent }),
    ],
    { concurrency: "unbounded" },
  )
  return Stream.concat(Stream.sync(isPresent), changes).pipe(
    Stream.changes,
    Stream.switchMap((present) =>
      present ? client.present().pipe(Stream.catchCause(() => Stream.empty), Stream.repeat(Schedule.spaced(PRESENCE_RETRY))) : Stream.empty,
    ),
  )
}).pipe(Stream.unwrap)

/**
 * The terminal of each alert tapped: the one the page was opened for (its
 * `?terminal=`), then each the service worker passes to this open page.
 */
export const alertTaps: Stream.Stream<Message> = Stream.concat(
  Stream.suspend(() => Stream.fromIterable(Option.toArray(openedFor()))),
  Option.match(Option.fromNullishOr(navigator.serviceWorker), {
    onNone: () => Stream.empty,
    onSome: (container) =>
      Dom.streamFromEventFilterMap({ target: container, type: "message", filterMapEvent: (event) => Option.map(S.decodeUnknownOption(TappedAlert)(event.data), ({ terminal }) => terminal) }),
  }),
).pipe(Stream.map((address) => Message.ClickedTerminal({ address })))

/** A browser call that failed, or a subscription it gave without keys. */
class BrowserRefused extends S.TaggedError<BrowserRefused, { readonly brand: unique symbol }>()("BrowserRefused", { message: S.String }) {}

const browser = <A>(what: string, call: () => Promise<A>) => Effect.tryPromise({ try: call, catch: () => new BrowserRefused({ message: `the browser ${what}` }) })

/** Why this browser cannot have alerts; none when it can. */
const unavailable = (): Option.Option<string> =>
  !window.isSecureContext
    ? Option.some("alerts need the page over HTTPS")
    : !("serviceWorker" in navigator && "PushManager" in window && "Notification" in window)
      ? Option.some("this browser has no push alerts; on an iPhone, add the page to the Home Screen and open it from there")
      : Option.none()

const registration = browser("did not find the alert worker", () => navigator.serviceWorker.getRegistration()).pipe(Effect.map(Option.fromNullishOr))

/** The browser's subscription for this device, when it has one. */
const browserSubscription = Effect.flatMap(
  registration,
  Option.match({
    onNone: () => Effect.succeedNone,
    onSome: (found) => browser("did not read its subscription", () => found.pushManager.getSubscription()).pipe(Effect.map(Option.fromNullishOr)),
  }),
)

/** This device's subscription, when it has one, as the bridge takes it. */
const current = browserSubscription.pipe(
  Effect.flatMap(Option.match({ onNone: () => Effect.succeedNone, onSome: (found) => Effect.asSome(decoded(found)) })),
)

const decoded = (subscription: globalThis.PushSubscription) =>
  S.decodeUnknownEffect(PushSubscription)(subscription.toJSON()).pipe(Effect.mapError(() => new BrowserRefused({ message: "the browser gave a subscription without keys" })))

const subscribe = (subscription: PushSubscription, events: ReadonlyArray<AlertEvent>) => Effect.flatMap(BridgeClient, (client) => client.subscribePush({ subscription, events }))

const got = (alerts: Alerts) => Message.GotAlerts({ alerts, note: Option.none() })
const noted = (alerts: Alerts, note: string) => Message.GotAlerts({ alerts, note: Option.some(note) })

const reasonOf = (error: BrowserRefused | BridgeError | RpcClientError.RpcClientError) =>
  Match.valueTags(error, { BrowserRefused: ({ message }) => message, BridgeError: failureReason, RpcClientError: failureReason })

/** The page was opened from an alert: the terminal it names. The address leaves the URL, so a reload opens as usual. */
const openedFor = () => {
  const terminal = Option.fromNullishOr(new URLSearchParams(location.search).get("terminal"))
  if (Option.isSome(terminal)) {
    history.replaceState(null, "", location.pathname)
  }
  return terminal
}

const TappedAlert = S.Struct({ terminal: S.String })

const PRESENCE_RETRY = "2 seconds"
