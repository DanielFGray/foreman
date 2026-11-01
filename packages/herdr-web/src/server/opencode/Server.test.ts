import { Option } from "effect"
import { expect, test } from "vitest"
import { pairingLink } from "./Server.ts"

// Made-up output in the form `opencode pair` prints: one link per address the server listens on.
const printed = (...links: ReadonlyArray<string>) => ["Open a link on the device to pair:", ...links.map((link) => `  ${link}`), "", "Links work once and expire in 5 minutes."].join("\n")

test("the pairing link is the one at this machine's loopback address", () => {
  expect(pairingLink(printed("http://192.168.0.9:4096/auth/connect/code-one", "http://127.0.0.1:4096/auth/connect/code-two")).pipe(Option.map(String))).toEqual(
    Option.some("http://127.0.0.1:4096/auth/connect/code-two"),
  )
  expect(pairingLink(printed("http://[::1]:4096/auth/connect/code-three")).pipe(Option.map(String))).toEqual(Option.some("http://[::1]:4096/auth/connect/code-three"))
})

test("no link is taken that leaves this machine or goes elsewhere on the server", () => {
  expect(pairingLink(printed("http://192.168.0.9:4096/auth/connect/code-one"))).toEqual(Option.none())
  expect(pairingLink(printed("https://127.0.0.1:4096/auth/connect/code-one"))).toEqual(Option.none())
  expect(pairingLink(printed("http://127.0.0.1:4096/api/session"))).toEqual(Option.none())
  expect(pairingLink(printed("http://127.0.0.1:4096/auth/connect/code/../../api"))).toEqual(Option.none())
  expect(pairingLink("the service is not running")).toEqual(Option.none())
})
