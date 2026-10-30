import { describe, expect, test } from "vitest"
import { Option } from "effect"
import { allowedHosts, isAllowed, LOOPBACK } from "./Access.ts"

const hosts = allowedHosts(4180, ["box.tailnet.ts.net"])
const allowed = (host: string, origin?: string) => isAllowed(hosts, Option.some(host), Option.fromUndefinedOr(origin))

describe("Access", () => {
  test("listens on loopback only", () => {
    expect(LOOPBACK).toBe("127.0.0.1")
  })

  test("serves loopback hosts, with or without an Origin from one", () => {
    expect(allowed("localhost:4180")).toBe(true)
    expect(allowed("127.0.0.1:4180", "http://127.0.0.1:4180")).toBe(true)
    expect(allowed("[::1]:4180", "http://localhost:4180")).toBe(true)
  })

  test("serves a host named in HERDR_WEB_HOSTS", () => {
    expect(allowed("box.tailnet.ts.net", "https://box.tailnet.ts.net")).toBe(true)
  })

  test("refuses a page from another origin", () => {
    expect(allowed("localhost:4180", "http://evil.example")).toBe(false)
    expect(allowed("localhost:4180", "null")).toBe(false)
  })

  test("refuses a rebound host name, even from its own origin", () => {
    expect(allowed("evil.example:4180", "http://evil.example:4180")).toBe(false)
  })

  test("refuses another port and a missing Host", () => {
    expect(allowed("localhost:9999")).toBe(false)
    expect(isAllowed(hosts, Option.none(), Option.none())).toBe(false)
  })
})
