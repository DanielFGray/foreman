import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { connectionAt, store, type Run } from "tasks";
import { Records } from "./records.ts";
import { Tracker } from "./tracker.ts";
import { agentLog, attemptsOf, type Item, walledBy } from "./records.ts";
import { authoredBy, reviewedBy, reviewerNamed, roundsOf, routedCommit } from "./lap.ts";
import { newRunFor } from "./run-record.ts";
import { NO_WRITES, type RunEvent, stepOf, type StepRules } from "./run-step.ts";
import { authorRun, authoredOn, charged, reviewRun, stoppedRun, withRuns } from "./task-fixture.ts";

/** The run row a dispatch of `role` on `rung` opens for the task. */
const dispatchOf = (id: string, role: "author" | "review", rung: string, commit?: string) =>
  newRunFor({
    task: { id, title: id, project: "foreman", labels: [] },
    branch: `foreman/${id}`,
    harness: "test",
    model: undefined,
    rung,
    provider: undefined,
    role,
    node: role,
    commit,
  });

/** One rung and no drawing: the rules the store tests below need. */
const RULES: StepRules = {
  ladder: [{ name: "cheap", harness: "test", model: undefined, provider: undefined }],
  attemptsPerRung: 2,
  pipeline: undefined,
};

/** Writes the row `event` makes on the task as the store holds it, with no drawing. */
const record = (id: string, event: RunEvent) =>
  run((records) =>
    records
      .show(id)
      .pipe(Effect.flatMap((task) => records.write(id, stepOf(task, event, RULES).row))),
  );

/** Runs `f` against foreman's records and the tracker, over one store connection. */
const run = <A, E>(
  f: (records: Records["Service"], tracker: Tracker["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* Records, yield* Tracker);
    }).pipe(Effect.provide(Records.layer.pipe(Layer.provide(store)))),
  );

const item = (): Item => ({
  id: "ts-123456",
  title: "Test task",
  status: "in_progress",
  project: "foreman",
  type: "task",
  priority: 1,
  labels: [],
  description: "",
  parent: undefined,
  lastActivityAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(0),
  definitionOfDone: undefined,
  runs: [],
  charges: [],
  parked: undefined,
  tip: undefined,
});

/** The task with these runs, oldest first. */
const tried = (...runs: ReadonlyArray<Run>): Item => withRuns(item(), runs);

describe("task attribution", () => {
  test("keeps author and current reviewer distinct", () => {
    const task = withRuns(
      authoredOn(item(), "opencode"),
      [reviewRun("claude", { ending: "approved", commit: "c1" })],
      "c1",
    );

    expect(authoredBy(task)).toBe("opencode");
    expect(reviewedBy(task)).toBe("claude");
    expect(reviewerNamed(task)).toBe(true);
    expect(routedCommit(task)).toBe("c1");
  });

  test("names the rung and the model the agent reported", () => {
    const rung = {
      name: "sol",
      harness: "opencode",
      model: "opencode/gpt-5.6-sol",
      provider: undefined,
    };
    expect(agentLog("author", rung, { kind: "opencode", model: "openai/gpt-5.6-sol" })).toBe(
      "foreman: author assigned to sol (openai/gpt-5.6-sol)",
    );
  });

  test("falls back to the model foreman asked for when none is reported", () => {
    const rung = {
      name: "sonnet",
      harness: "opencode",
      model: "opencode/claude-sonnet-5",
      provider: undefined,
    };
    expect(agentLog("review", rung, { kind: "opencode", model: undefined })).toBe(
      "foreman: review assigned to sonnet (opencode/claude-sonnet-5)",
    );
  });

  test("names the harness for a rung that lets the harness choose", () => {
    const rung = { name: "claude", harness: "claude", model: undefined, provider: undefined };
    expect(agentLog("author", rung, { kind: "claude", model: undefined })).toBe(
      "foreman: author assigned to claude (claude)",
    );
  });
});

describe("stopped attempts on a rung", () => {
  test("reads zero for a rung that was never tried", () => {
    expect(attemptsOf(item(), "deepseek")).toBe(0);
    expect(attemptsOf(authoredOn(item(), "opencode"), "deepseek")).toBe(0);
  });

  test("counts the rung's author runs that stopped or vanished", () => {
    expect(attemptsOf(tried(stoppedRun("deepseek")), "deepseek")).toBe(1);
    expect(
      attemptsOf(tried(stoppedRun("deepseek"), stoppedRun("deepseek", "vanished")), "deepseek"),
    ).toBe(2);
  });

  test("ignores the runs of a rung the task left", () => {
    // The count follows its rung, so a task pinned elsewhere starts fresh and
    // a climb-away clears nothing it might meet again.
    const deepseek = [stoppedRun("deepseek"), stoppedRun("deepseek")];
    expect(attemptsOf(tried(...deepseek), "sol")).toBe(0);
    expect(attemptsOf(tried(...deepseek, stoppedRun("sol")), "sol")).toBe(1);
  });

  test("counts only the runs after the rung's newest charge, forgiven or not", () => {
    const runs = [stoppedRun("deepseek"), stoppedRun("deepseek"), stoppedRun("deepseek")];
    const spent = runs[1]!;
    const charge = charged("deepseek", spent.id);
    expect(attemptsOf({ ...tried(...runs), charges: [charge] }, "deepseek")).toBe(1);
    expect(
      attemptsOf({ ...tried(...runs), charges: [{ ...charge, forgiven: true }] }, "deepseek"),
    ).toBe(1);
    // Another rung's charge ends nothing on this one.
    expect(attemptsOf({ ...tried(...runs), charges: [charged("sol", spent.id)] }, "deepseek")).toBe(
      3,
    );
  });

  test("keeps two rungs whose names share a prefix apart", () => {
    const flash = [stoppedRun("deepseek-flash"), stoppedRun("deepseek-flash")];
    expect(attemptsOf(tried(...flash), "deepseek")).toBe(0);
    expect(attemptsOf(tried(...flash), "deepseek-flash")).toBe(2);
  });

  test("ignores runs that named an exit, were released, hit a wall, are open, or reviewed", () => {
    const runs = [
      authorRun("deepseek", { open: false, ending: "done" }),
      authorRun("deepseek", { open: false, ending: "released" }),
      authorRun("deepseek", { open: false, ending: "walled" }),
      authorRun("deepseek"),
      reviewRun("deepseek", { open: false, ending: "stopped" }),
    ];
    expect(attemptsOf(tried(...runs), "deepseek")).toBe(0);
  });
});

describe("Records against a scratch store", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "foreman-prog-"));
    process.env.PROG_DB = join(directory, "prog.db");
    await Effect.runPromise(Effect.void.pipe(Effect.provide(connectionAt(process.env.PROG_DB))));
  });

  afterAll(async () => {
    delete process.env.PROG_DB;
    await rm(directory, { recursive: true, force: true });
  });

  test("a returned review starts its next author without reopening the task", async () => {
    const id = (await Bun.$`prog add "review cycle" -p foreman`.text()).trim();
    await run((_, tracker) => tracker.claim(id));
    await record(id, { _tag: "AuthorStarted", run: dispatchOf(id, "author", "cheap") });
    await run((_, tracker) => tracker.claim(id));
    await record(id, { _tag: "ReviewStarted", run: dispatchOf(id, "review", "dear", "c1") });
    await record(id, { _tag: "ExitNamed", name: "returned", commit: "c1" });
    await run((records) => records.endRuns(id, { review: "stopped" }));

    expect((await run((records) => records.show(id))).status).toBe("in_progress");
    await run((_, tracker) => tracker.claim(id));
    await record(id, { _tag: "AuthorStarted", run: dispatchOf(id, "author", "dear") });
    const after = await run((records) => records.show(id));
    expect(after.status).toBe("in_progress");
    expect(after.runs.map((run) => [run.role, run.ending])).toEqual([
      ["author", "done"],
      ["review", "returned"],
      ["author", undefined],
    ]);
  });

  // A reviewer can approve and then return the work in one turn. Releasing the
  // task closes the review run, so no open run outlives the review that
  // opened it and the requeued task is not read as still under review.
  test("release closes the review run and requeues the task", async () => {
    const id = (await Bun.$`prog add "returned approval" -p foreman`.text()).trim();
    await record(id, { _tag: "AuthorStarted", run: dispatchOf(id, "author", "cheap") });
    await run((_, tracker) => tracker.claim(id));
    await record(id, { _tag: "ReviewStarted", run: dispatchOf(id, "review", "dear", "c1") });

    await run((records) => records.release(id));
    const after = await run((records) => records.show(id));

    expect(after.status).toBe("open");
    expect(after.runs.map((r) => [r.role, r.open, r.ending])).toEqual([
      ["author", false, "done"],
      ["review", false, "released"],
    ]);
  });

  // A retried review replaces a reviewer that vanished, so the lap holds one open review run.
  test("assigning a reviewer ends the review run it replaces as released", async () => {
    const id = (await Bun.$`prog add "vanished reviewer" -p foreman`.text()).trim();
    await record(id, { _tag: "AuthorStarted", run: dispatchOf(id, "author", "cheap") });
    await run((_, tracker) => tracker.claim(id));
    await record(id, { _tag: "ReviewStarted", run: dispatchOf(id, "review", "cheap", "c1") });
    await record(id, { _tag: "ReviewStarted", run: dispatchOf(id, "review", "dear", "c1") });

    const after = await run((records) => records.show(id));
    expect(after.runs.map((r) => [r.role, r.rung, r.open, r.ending])).toEqual([
      ["author", "cheap", false, "done"],
      ["review", "cheap", false, "released"],
      ["review", "dear", true, undefined],
    ]);
  });

  // One status the schema does not name fails the decode of the whole list,
  // which drops every epic's progress for that project.
  test("reads an epic's children whatever status prog filed them at", async () => {
    const epic = (await Bun.$`prog add "epic" -p foreman -e`.text()).trim().split("\n")[0]!;
    for (const status of ["proposed", "draft", "blocked"]) {
      await Bun.$`prog add ${status} -p foreman --parent ${epic} --status ${status}`.quiet();
    }

    const children = await run((records) => records.children(epic));

    expect(children.map((child) => child.status).sort()).toEqual(["blocked", "draft", "proposed"]);
  });

  // A correction round counts against the author who received it, so the next
  // author's trial row must not inherit it.
  test("counts correction rounds on the author run, even after its handoff, and a new author starts at none", async () => {
    const id = (await Bun.$`prog add "round" -p foreman`.text()).trim().split("\n")[0]!;
    await record(id, { _tag: "AuthorStarted", run: dispatchOf(id, "author", "cheap") });

    expect(await run((records) => records.countRound(id))).toBe(1);
    await run((_, tracker) => tracker.claim(id));
    await record(id, { _tag: "ReviewStarted", run: dispatchOf(id, "review", "dear", "c1") });
    expect(await run((records) => records.countRound(id))).toBe(2);
    expect(roundsOf(await run((records) => records.show(id)))).toBe(2);
    await run((records) => records.release(id));
    await record(id, { _tag: "AuthorStarted", run: dispatchOf(id, "author", "cheap") });

    const after = await run((records) => records.show(id));
    expect(roundsOf(after)).toBe(0);
    expect(after.labels).toEqual([]);
    expect(after.charges).toEqual([]);
    expect(after.parked).toBeUndefined();
    expect(after.runs.at(-1)).toMatchObject({ role: "author", rung: "cheap", open: true });
  });

  test("names the operation a store failure came from", async () => {
    const error = await run((records) =>
      Effect.flip(
        records.write("ts-does-not-exist", stepOf(item(), { _tag: "Landed" }, RULES).row),
      ),
    );

    expect(error.command).toBe("done ts-does-not-exist");
    expect(error.detail).toContain("not found");
  });

  test("claims a done task with an unread branch back into the pipeline", async () => {
    const id = (await Bun.$`prog add "unread branch" -p foreman`.text()).trim();
    await Bun.$`prog done ${id}`.quiet();

    await run((_, tracker) => tracker.claim(id));
    const after = await run((records) => records.show(id));

    expect(after.status).toBe("in_progress");
  });

  // The records and the tracker share one connection, so a failed exit write
  // takes the status move in its transaction back with it.
  test("a failed exit write leaves the status untouched", async () => {
    const id = await run((_, tracker) =>
      tracker.add({ project: "foreman", title: "no open run", description: "", labels: [] }),
    );
    await run((_, tracker) => tracker.claim(id));

    const refused = await run((records) =>
      Effect.flip(
        records.write(id, {
          ...NO_WRITES,
          exit: { name: "returned", commit: "c1" },
          move: "reopen",
        }),
      ),
    );
    const after = await run((records) => records.show(id));

    expect(refused.detail).toContain("no open run");
    expect(after.status).toBe("in_progress");
    expect(after.runs).toEqual([]);
  });
});

describe("usage walls", () => {
  const ladder = [
    { name: "free", harness: "opencode", model: "opencode/free" },
    { name: "dear", harness: "claude", model: undefined },
  ] as unknown as Parameters<typeof walledBy>[1];

  test("a walled run names its rung's account until the task lands", () => {
    const walled = authorRun("free", { open: false, ending: "walled" });
    expect(walledBy({ runs: [walled] }, ladder)).toEqual(["opencode"]);
    const landed = authorRun("dear", { open: false, ending: "done", landed: true });
    expect(walledBy({ runs: [walled, landed] }, ladder)).toEqual([]);
    expect(walledBy({ runs: [landed, { ...walled, id: landed.id + 1 }] }, ladder)).toEqual([
      "opencode",
    ]);
  });
});
