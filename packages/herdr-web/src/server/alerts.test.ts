import { type Duration, Effect, Fiber, Option, Queue, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import type { Fleet, StatusState, Terminal } from "../shared/Fleet.ts"
import { type Alert, alertsBetween, watchAlerts } from "./alerts.ts"

const shell: Terminal = {
  address: "t2",
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state: "live",
  status: Option.none(),
  foreground: Option.some({ name: "zsh", pid: 2, argv: ["zsh"], cwd: "/" }),
  labels: {},
  status_ms: Option.none(),
  created_ms: 0,
  records: Option.none(),
  parent: Option.none(),
  cols: 80,
  rows: 24,
}

const agent = (state: StatusState): Terminal => ({
  ...shell,
  address: "t1",
  foreground: Option.some({ name: "claude", pid: 1, argv: ["claude"], cwd: "/" }),
  status: Option.some({ state, app: Option.some("claude-code"), msg: Option.none(), kind: Option.none(), progress: Option.none() }),
})

const fleet = (terminals: ReadonlyArray<Terminal>, connected = true): Fleet => ({ connected, terminals, machines: [], git: {} })

const events = (previous: Fleet, next: Fleet) => alertsBetween(previous, next).map(({ terminal, event }) => `${terminal} ${event}`)

describe("alertsBetween", () => {
  test("an agent's new status is an alert, named after its program", () => {
    expect(alertsBetween(fleet([agent("working"), shell]), fleet([agent("blocked"), shell]))).toEqual([{ terminal: "t1", event: "blocked", title: "claude" }])
  })

  test("a terminal's first sighting, and a change of message alone, are not news", () => {
    expect(events(fleet([shell]), fleet([shell, agent("blocked")]))).toEqual([])
    const noted = { ...agent("working"), status: Option.map(agent("working").status, (status) => ({ ...status, msg: Option.some("reading") })) }
    expect(events(fleet([agent("working")]), fleet([noted]))).toEqual([])
  })

  test("an agent's terminal ends when it finishes or goes away; a shell's does not", () => {
    expect(events(fleet([agent("done")]), fleet([{ ...agent("done"), state: "finished" }]))).toEqual(["t1 ended"])
    expect(events(fleet([agent("done"), shell]), fleet([]))).toEqual(["t1 ended"])
  })

  test("an agent on another machine ends only while that machine is still reached", () => {
    const remote = { ...agent("working"), address: "box/t1" }
    const on = (state: "connected" | "unreachable"): Fleet => ({ ...fleet([]), machines: [{ name: "box", isLocal: false, state, spaces: [] }] })
    expect(events({ ...on("connected"), terminals: [remote] }, on("unreachable"))).toEqual([])
    expect(events({ ...on("connected"), terminals: [remote] }, on("connected"))).toEqual(["box/t1 ended"])
  })

  test("nothing counts across a lost connection to hc", () => {
    expect(events(fleet([agent("working")]), fleet([agent("working")], false))).toEqual([])
    expect(events(fleet([agent("working")], false), fleet([]))).toEqual([])
  })
})

describe("watchAlerts", () => {
  /**
   * Feeds each fleet to watchAlerts once its `after` has passed, then waits
   * out the delay. Gives what was delivered after each step and at the end.
   */
  const delivered = (steps: ReadonlyArray<{ readonly fleet: Fleet; readonly after: Duration.Input }>) =>
    Effect.gen(function* () {
      const fleets = yield* Queue.unbounded<Fleet>()
      const sent = yield* Ref.make<ReadonlyArray<string>>([])
      const deliver = ({ terminal, event }: Alert) => Ref.update(sent, (all) => [...all, `${terminal} ${event}`])
      const watching = yield* Effect.forkChild(watchAlerts(Stream.fromQueue(fleets), deliver))
      const seen = yield* Effect.forEach(steps, ({ fleet, after }) =>
        TestClock.adjust(after).pipe(Effect.andThen(Queue.offer(fleets, fleet)), Effect.andThen(Effect.yieldNow), Effect.andThen(Ref.get(sent))),
      )
      yield* TestClock.adjust("10 seconds")
      const last = yield* Ref.get(sent)
      yield* Fiber.interrupt(watching)
      return [...seen, last]
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)

  test("an alert goes out after the delay, not before", async () => {
    expect(await delivered([{ fleet: fleet([agent("working")]), after: "0 millis" }, { fleet: fleet([agent("blocked")]), after: "1 second" }])).toEqual([
      [],
      [],
      ["t1 blocked"],
    ])
  })

  test("a change in the same terminal calls off the alert that waits, and waits in its place", async () => {
    expect(
      await delivered([
        { fleet: fleet([agent("working")]), after: "0 millis" },
        { fleet: fleet([agent("blocked")]), after: "1 second" },
        { fleet: fleet([agent("working")]), after: "3 seconds" },
      ]),
    ).toEqual([[], [], [], ["t1 working"]])
  })
})
