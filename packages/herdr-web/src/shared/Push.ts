// Push alerts: what a phone or browser can ask to be told about, the
// subscription its browser hands over, and the message the bridge sends.
import { Schema as S } from "effect"
import { StatusState } from "./Fleet.ts"

/** A change in an agent's terminal worth an alert: a new status, or its terminal ended. */
export const AlertEvent = S.Literals([...StatusState.literals, "ended"])
export type AlertEvent = typeof AlertEvent.Type

/** An agent that waits for you, finished, failed or ended; working and idle are the busy baseline. */
export const DEFAULT_ALERT_EVENTS: ReadonlyArray<AlertEvent> = ["blocked", "done", "error", "ended"]

/**
 * A browser's push subscription, as its `toJSON()` gives it: the address on
 * its vendor's push service and the keys to encrypt for it. The endpoint is a
 * capability: anyone who holds it can send to the device, so it is never logged.
 */
export const PushSubscription = S.Struct({
  endpoint: S.String,
  keys: S.Struct({ p256dh: S.String, auth: S.String }),
})
export type PushSubscription = typeof PushSubscription.Type

/**
 * What the service worker (public/sw.js) shows. `terminal` is the address a
 * tap opens; none for a test alert. `tag` gives each terminal one slot, so a
 * newer alert replaces an older one.
 */
export const PushPayload = S.Struct({
  title: S.String,
  body: S.String,
  tag: S.String,
  terminal: S.OptionFromNullOr(S.String),
})
export type PushPayload = typeof PushPayload.Type
