import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import type { Item } from "tasks";
import { DEFAULT_POLICY, setProjectTracker, type Policy } from "./policy.ts";
import { routeByProject, Tracker, TrackerError } from "./tracker.ts";

const item = (id: string, project: string) => ({ id, project }) as unknown as Item;

/** A tracker that records each call it answers and serves `items`. */
const recording = (name: string, calls: Array<string>, items: ReadonlyArray<Item>) => {
  const note = (call: string) => Effect.sync(() => void calls.push(`${name} ${call}`));
  return Tracker.of({
    refresh: (project) => note(`refresh ${project}`),
    lookup: (task) => note(`lookup ${task}`).pipe(Effect.as(Option.none())),
    list: (filter) => note(`list ${JSON.stringify(filter)}`).pipe(Effect.as(items)),
    dependencies: (project) => note(`dependencies ${project}`).pipe(Effect.as([])),
    ready: (project) => note(`ready ${project}`).pipe(Effect.as(items)),
    logs: (task) => note(`logs ${task}`).pipe(Effect.as([])),
    add: (task) => note(`add ${task.project}`).pipe(Effect.as("new")),
    claim: (task) => note(`claim ${task}`),
    reopen: (task) => note(`reopen ${task}`),
    complete: (task) => note(`complete ${task}`),
    cancel: (task) => note(`cancel ${task}`),
    label: (task, label) => note(`label ${task} ${label}`),
    unlabel: (task, label) => note(`unlabel ${task} ${label}`),
    relabel: (task) => note(`relabel ${task}`).pipe(Effect.as([])),
    log: (task) => note(`log ${task}`),
    url: (task) => note(`url ${task}`).pipe(Effect.as(Option.none())),
  });
};

const failing = Tracker.of(
  Object.fromEntries(
    [
      "refresh",
      "lookup",
      "list",
      "dependencies",
      "ready",
      "logs",
      "add",
      "claim",
      "reopen",
      "complete",
      "label",
      "unlabel",
      "relabel",
      "log",
      "url",
    ].map((method) => [
      method,
      () =>
        Effect.fail(new TrackerError({ command: "github tracker", detail: "adapter not built" })),
    ]),
  ) as unknown as Tracker["Service"],
);

const world = (policy: Policy, github: Tracker["Service"] | "recording" = "recording") => {
  const calls: Array<string> = [];
  let reads = 0;
  const progItems = [item("ts-1", "alpha"), item("ts-2", "beta")];
  const tracker = routeByProject(
    {
      prog: recording("prog", calls, progItems),
      github:
        github === "recording" ? recording("github", calls, [item("beta#7", "beta")]) : github,
      linear: recording("linear", calls, []),
    },
    Effect.sync(() => {
      reads += 1;
      return policy;
    }),
  );
  return { tracker, calls, reads: () => reads };
};

const onGithub = setProjectTracker(DEFAULT_POLICY, "beta", "github");

describe("routeByProject", () => {
  test("a prog id goes to prog and reads no policy", async () => {
    const { tracker, calls, reads } = world(onGithub);
    await Effect.runPromise(tracker.claim("ts-1"));
    await Effect.runPromise(tracker.label("ts-1", "size:2"));
    expect(calls).toEqual(["prog claim ts-1", "prog label ts-1 size:2"]);
    expect(reads()).toBe(0);
  });

  test("an issue id goes to its project's tracker", async () => {
    const { tracker, calls } = world(onGithub);
    await Effect.runPromise(tracker.complete("beta#7"));
    await Effect.runPromise(tracker.lookup("alpha#3"));
    expect(calls).toEqual(["github complete beta#7", "prog lookup alpha#3"]);
  });

  test("show, log and url route a prog, a GitHub and a Linear id to its tracker", async () => {
    const { tracker, calls } = world(setProjectTracker(onGithub, "gamma", "linear"));
    for (const id of ["ts-1", "beta#7", "gamma#ENG-3"]) {
      await Effect.runPromise(tracker.lookup(id));
      await Effect.runPromise(tracker.logs(id));
      await Effect.runPromise(tracker.log(id, "note"));
      await Effect.runPromise(tracker.url(id));
    }
    expect(calls).toEqual([
      ...["lookup", "logs", "log", "url"].map((call) => `prog ${call} ts-1`),
      ...["lookup", "logs", "log", "url"].map((call) => `github ${call} beta#7`),
      ...["lookup", "logs", "log", "url"].map((call) => `linear ${call} gamma#ENG-3`),
    ]);
  });

  test("calls that name a project or a parent route by it", async () => {
    const { tracker, calls } = world(onGithub);
    await Effect.runPromise(tracker.ready("beta"));
    await Effect.runPromise(tracker.dependencies("alpha"));
    await Effect.runPromise(
      tracker.add({ project: "beta", title: "t", description: "", labels: [] }),
    );
    await Effect.runPromise(tracker.list({ parent: "beta#1" }));
    expect(calls).toEqual([
      "github ready beta",
      "prog dependencies alpha",
      "github add beta",
      'github list {"parent":"beta#1"}',
    ]);
  });

  test("ready everywhere joins prog's own projects with each other tracker's", async () => {
    const { tracker } = world(onGithub);
    const ready = await Effect.runPromise(tracker.ready(undefined));
    expect(ready.map((each) => each.id)).toEqual(["ts-1", "beta#7"]);
  });

  test("a tracker that fails is left out of a read everywhere", async () => {
    const { tracker } = world(onGithub, failing);
    const ready = await Effect.runPromise(tracker.ready(undefined));
    expect(ready.map((each) => each.id)).toEqual(["ts-1"]);
  });

  test("a call routed to a tracker that fails fails", async () => {
    const { tracker } = world(onGithub, failing);
    const exit = await Effect.runPromiseExit(tracker.claim("beta#7"));
    expect(exit._tag).toBe("Failure");
  });
});
