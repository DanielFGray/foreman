// Web Push: alerts that reach a phone or browser even when the page is
// closed there. A browser hands the page a subscription (an address on its
// vendor's push service, and the keys to encrypt for it); the bridge posts
// encrypted alerts there, signed with its VAPID key (the key pair that
// identifies this bridge to push services). Both live in the bridge's config
// folder, so a restart neither unsubscribes a phone nor changes the key.
//
// No alert goes out while a page is in front and focused somewhere: whoever
// sits there already sees the change. Such a page holds `present` open.
import { Array, Context, Effect, FileSystem, Layer, Option, Record, Ref, Schema as S, Stream, SynchronizedRef } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import webpush from "web-push"
import { BridgeError } from "../shared/Api.ts"
import { AlertEvent, PushPayload, PushSubscription } from "../shared/Push.ts"
import { type Alert, watchAlerts } from "./alerts.ts"
import { ConfigFolder } from "./configFolder.ts"
import { FleetModel } from "./FleetModel.ts"

export class Push extends Context.Service<Push>()("herdr-web/server/Push", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const http = yield* HttpClient.HttpClient
    const fleet = yield* FleetModel
    const folder = yield* ConfigFolder
    const files = { keys: `${folder}/push-key.json`, subscriptions: `${folder}/push-subscriptions.json` }

    const save = <A, I>(file: string, schema: S.Codec<A, I>, value: A) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 })
        const written = `${file}.new`
        yield* fs.remove(written).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void))
        yield* fs.writeFileString(written, yield* S.encodeEffect(S.fromJsonString(schema))(value), { flag: "wx", mode: 0o600 })
        yield* fs.rename(written, file)
      }).pipe(Effect.mapError(({ message }) => new BridgeError({ kind: "push", message: `${file} cannot be saved: ${message}` })))

    // Every subscription is bound to this key pair, so a new one would orphan
    // every subscribed device without a word: a key file that cannot be read
    // is an error, and only a missing one is made anew.
    const keys = yield* Effect.cached(
      fs.readFileString(files.keys).pipe(
        Effect.flatMap(S.decodeEffect(S.fromJsonString(VapidKeys))),
        Effect.catchReason("PlatformError", "NotFound", () => {
          const made = webpush.generateVAPIDKeys()
          return Effect.as(save(files.keys, VapidKeys, made), made)
        }),
        Effect.mapError((error) => (error._tag === "BridgeError" ? error : new BridgeError({ kind: "push", message: `${files.keys} cannot be read; move it away to make a new key` }))),
      ),
    )

    // A page sends its subscription again each time it opens, so a list that
    // cannot be read is started anew rather than refused.
    const loaded = yield* fs.readFileString(files.subscriptions).pipe(
      Effect.flatMap(S.decodeEffect(S.fromJsonString(Subscribers))),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
      Effect.catch(() => Effect.as(Effect.logWarning(`${files.subscriptions} cannot be read; the devices subscribe again when they open the page`), [])),
    )
    const subscribers = yield* SynchronizedRef.make<ReadonlyArray<Subscriber>>(loaded)
    const change = (f: (all: ReadonlyArray<Subscriber>) => ReadonlyArray<Subscriber>) =>
      SynchronizedRef.updateEffect(subscribers, (all) => {
        const next = f(all)
        return Effect.as(save(files.subscriptions, Subscribers, next), next)
      })
    const forget = (endpoint: string) => change(Array.filter(({ subscription }) => subscription.endpoint !== endpoint))

    const present = yield* Ref.make(0)

    /** Posts the payload to one device. A device whose push service has dropped its subscription is forgotten. */
    const send = (subscription: PushSubscription, payload: PushPayload) =>
      Effect.gen(function* () {
        const vapid = yield* keys
        const text = yield* S.encodeEffect(S.fromJsonString(PushPayload))(payload).pipe(Effect.mapError(pushError("cannot be encoded")))
        const details = yield* Effect.try({
          try: () => webpush.generateRequestDetails(subscription, text, { vapidDetails: { subject: SUBJECT, ...vapid }, TTL: TTL_SECONDS, urgency: "high" }),
          catch: pushError("cannot be encrypted for the device"),
        })
        // The endpoint is a capability, so no error names it; only its push service's host.
        const host = new URL(details.endpoint).host
        const response = yield* http
          // web-push gives some header values as numbers, and the body as a Buffer.
          .execute(HttpClientRequest.post(details.endpoint).pipe(HttpClientRequest.setHeaders(Record.map(details.headers, String)), HttpClientRequest.bodyUint8Array(new Uint8Array(details.body))))
          .pipe(
            // A push service answers; it never redirects, and a redirect would send the alert elsewhere.
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
            Effect.timeout(SEND_TIMEOUT),
            Effect.mapError(pushError(`did not reach ${host}`)))
        if (response.status === 404 || response.status === 410) {
          yield* forget(subscription.endpoint)
          return yield* new BridgeError({ kind: "push", message: `${host} no longer knows the device; turn alerts on again there` })
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* new BridgeError({ kind: "push", message: `${host} refused the alert with status ${response.status}` })
        }
      })

    const deliver = (alert: Alert) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(present)) > 0) {
          return
        }
        const wanted = Array.filter(yield* SynchronizedRef.get(subscribers), ({ events }) => Array.contains(events, alert.event))
        const payload: PushPayload = { title: alert.title, body: BODY[alert.event], tag: `herdr-${alert.terminal}`, terminal: Option.some(alert.terminal) }
        yield* Effect.forEach(wanted, ({ subscription }) => send(subscription, payload).pipe(Effect.catch((error) => Effect.logWarning("an alert was not sent", error.message))), {
          concurrency: "unbounded",
          discard: true,
        })
      })

    yield* Effect.forkScoped(watchAlerts(fleet.changes, deliver))

    return {
      /** The public half of the VAPID key: the `applicationServerKey` a browser subscribes with. */
      publicKey: Effect.map(keys, ({ publicKey }) => publicKey),
      /** Alerts the device for these events; a device already subscribed gets its new events. */
      subscribe: (subscription: PushSubscription, events: ReadonlyArray<AlertEvent>) =>
        change((all) => [...Array.filter(all, (other) => other.subscription.endpoint !== subscription.endpoint), { subscription, events }]),
      unsubscribe: forget,
      /** Sends a test alert to the device now, even with a page in front. */
      test: (subscription: PushSubscription) => send(subscription, { title: "herdr", body: "Alerts are on for this device.", tag: "herdr-test", terminal: Option.none() }),
      /** Holds alerts back for as long as the stream is open. It emits nothing. */
      present: Stream.unwrap(Effect.as(Effect.acquireRelease(Ref.update(present, (n) => n + 1), () => Ref.update(present, (n) => n - 1)), Stream.never)),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

const VapidKeys = S.Struct({ publicKey: S.String, privateKey: S.String })

const Subscriber = S.Struct({ subscription: PushSubscription, events: S.Array(AlertEvent) })
type Subscriber = typeof Subscriber.Type
const Subscribers = S.Array(Subscriber)

/** Push services want a contact for the sender of an alert. */
const SUBJECT = "https://github.com/DanielFGray/herdr-web"
/** An agent that waits is still waiting when the phone has signal again; a newer alert for the terminal replaces it anyway. */
const TTL_SECONDS = 12 * 60 * 60
const SEND_TIMEOUT = "10 seconds"

const BODY = {
  blocked: "waiting for you",
  done: "finished",
  error: "failed",
  ended: "its terminal ended",
  working: "working",
  idle: "idle",
} satisfies Record<AlertEvent, string>

const pushError = (what: string) => () => new BridgeError({ kind: "push", message: `the alert ${what}` })
