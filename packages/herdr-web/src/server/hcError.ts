// hc's failures as the page sees them.
import { Inspectable, Match } from "effect"
import type { HcFailure } from "../hc/Connection.ts"
import { BridgeError } from "../shared/Api.ts"

export const toBridgeError = (error: HcFailure) =>
  Match.valueTags(error, {
    HcError: ({ kind, message }) => new BridgeError({ kind, message }),
    HcLost: ({ cause }) => new BridgeError({ kind: "lost", message: `hc is not reachable: ${Inspectable.toStringUnknown(cause, 0)}` }),
    HcProtocolError: ({ cause }) => new BridgeError({ kind: "protocol", message: `unreadable reply from hc: ${Inspectable.toStringUnknown(cause, 0)}` }),
  })
