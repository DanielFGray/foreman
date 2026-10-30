import { Option } from "effect"
import { expect, test } from "vitest"
import type { Status, Terminal } from "../../shared/Fleet.ts"
import { type SessionSummary, shownSession } from "./Session.ts"

const terminal = (title: string, pending: ReadonlyArray<string> = []): Terminal => ({
  address: "t1",
  name: Option.none(),
  title: Option.some(title),
  cwd: "/work",
  state: "live",
  status: Option.some(status("idle")),
  status_ms: Option.none(),
  foreground: Option.some({ name: "opencode", pid: 1, argv: ["opencode"] }),
  labels: {},
  created_ms: 0,
  records: Option.some(Object.fromEntries(pending.map((id) => [id, status("working")]))),
  cols: 80,
  rows: 24,
  parent: Option.none(),
})

const status = (state: Status["state"]): Status => ({ state, app: Option.some("opencode"), msg: Option.none(), kind: Option.none(), progress: Option.none() })

const session = (id: string, title?: string, parent?: string): SessionSummary => ({
  id,
  title: Option.fromUndefinedOr(title),
  parentID: Option.fromUndefinedOr(parent),
  model: Option.none(),
})

const parser = session("ses_a", "Fix the parser")
const docs = session("ses_b", "Write the docs")

test("the title names the session, by OpenCode's clipped form of its title", () => {
  const long = session("ses_c", "Move the payment reconciliation job onto the stream")
  expect(shownSession(terminal("OC | Fix the parser"), [parser, docs], Option.none())).toEqual(Option.some("ses_a"))
  expect(shownSession(terminal("OC | Move the payment reconciliation job o…"), [parser, long], Option.none())).toEqual(Option.some("ses_c"))
  expect(shownSession(terminal("OC | Fix the parser"), [docs], Option.none())).toEqual(Option.none())
})

test("a subagent's session is never the one shown", () => {
  expect(shownSession(terminal("OC | Fix the parser"), [session("ses_child", "Fix the parser", "ses_x")], Option.none())).toEqual(Option.none())
})

test("among sessions with the same title, a working one wins, else the one shown before, else none", () => {
  const twin = session("ses_twin", "Fix the parser")
  expect(shownSession(terminal("OC | Fix the parser"), [parser, twin], Option.none())).toEqual(Option.none())
  expect(shownSession(terminal("OC | Fix the parser", ["ses_twin"]), [parser, twin], Option.none())).toEqual(Option.some("ses_twin"))
  expect(shownSession(terminal("OC | Fix the parser"), [parser, twin], Option.some("ses_a"))).toEqual(Option.some("ses_a"))
})

test("a session with no title of its own is known by its record, or by having been shown before", () => {
  const fresh = session("ses_new")
  const madeUp = session("ses_old", "New session - 2026-10-01T09:30:00.000Z")
  expect(shownSession(terminal("OpenCode", ["ses_new"]), [fresh, madeUp, parser], Option.none())).toEqual(Option.some("ses_new"))
  expect(shownSession(terminal("OpenCode", ["ses_a"]), [fresh, parser], Option.none())).toEqual(Option.none())
  expect(shownSession(terminal("OpenCode"), [fresh], Option.none())).toEqual(Option.none())
  expect(shownSession(terminal("OpenCode"), [fresh, madeUp], Option.some("ses_old"))).toEqual(Option.some("ses_old"))
})

test("a title OpenCode did not set leaves the choice to the records", () => {
  expect(shownSession(terminal("~/work"), [parser, docs], Option.none())).toEqual(Option.none())
  expect(shownSession(terminal("~/work", ["ses_b"]), [parser, docs], Option.none())).toEqual(Option.some("ses_b"))
})
