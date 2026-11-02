import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { connectionAt, store } from "tasks";
import { Prog } from "./prog.ts";
import { agentLog, attemptsOf, type Item } from "./prog.ts";
import { authoredBy, isApproved, reviewedBy, roundsOf } from "./lap.ts";
import { newRunFor } from "./run-record.ts";
import { authoredOn, reviewRun, withRuns } from "./task-fixture.ts";

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

const run = <A, E>(f: (prog: Prog["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Prog.use(f).pipe(Effect.provide(Prog.Default.pipe(Layer.provide(store)))));

const item = (labels: ReadonlyArray<string>): Item => ({
  id: "ts-123456",
  title: "Test task",
  status: "reviewing",
  project: "foreman",
  type: "task",
  priority: 1,
  labels,
  description: "",
  parent: undefined,
  lastActivityAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(0),
  definitionOfDone: undefined,
  runs: [],
  tip: undefined,
});

describe("task attribution", () => {
  test("keeps author and current reviewer distinct", () => {
    const task = withRuns(
      authoredOn(item([]), "opencode"),
      [reviewRun("claude", { ending: "approved", commit: "c1" })],
      "c1",
    );

    expect(authoredBy(task)).toBe("opencode");
    expect(reviewedBy(task)).toBe("claude");
    expect(isApproved(task)).toBe(true);
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

describe("unfinished attempts on a rung", () => {
  test("reads zero for a rung that was never tried", () => {
    expect(attemptsOf(item([]), "deepseek")).toBe(0);
    expect(attemptsOf(authoredOn(item([]), "opencode"), "deepseek")).toBe(0);
  });

  test("reads the count recorded for the named rung", () => {
    expect(attemptsOf(item(["attempt:deepseek:1"]), "deepseek")).toBe(1);
    expect(attemptsOf(item(["attempt:deepseek:2"]), "deepseek")).toBe(2);
  });

  test("ignores a count a rung the task left recorded", () => {
    // The count follows its rung, so a task pinned elsewhere starts fresh and
    // a climb-away clears nothing it might meet again.
    expect(attemptsOf(item(["attempt:deepseek:2"]), "sol")).toBe(0);
    expect(attemptsOf(item(["attempt:deepseek:2", "attempt:sol:1"]), "sol")).toBe(1);
  });

  test("reads the newest count when more than one was written", () => {
    expect(attemptsOf(item(["attempt:deepseek:1", "attempt:deepseek:3"]), "deepseek")).toBe(3);
  });

  test("keeps two rungs whose names share a prefix apart", () => {
    expect(attemptsOf(item(["attempt:deepseek-flash:2"]), "deepseek")).toBe(0);
    expect(attemptsOf(item(["attempt:deepseek-flash:2"]), "deepseek-flash")).toBe(2);
  });

  test("ignores a count that is not a plain number", () => {
    expect(attemptsOf(item(["attempt:deepseek:x"]), "deepseek")).toBe(0);
    expect(attemptsOf(item(["attempt:deepseek:2.5"]), "deepseek")).toBe(0);
  });
});

describe("Prog against a scratch store", () => {
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

  // A reviewer can approve and then return the work in one turn. Releasing the
  // task closes the review run, so no open run outlives the review that
  // opened it and the requeued task is not read as still under review.
  test("release closes the review run and requeues the task", async () => {
    const id = (await Bun.$`prog add "returned approval" -p foreman`.text()).trim();
    await run((prog) => prog.attribute(id, dispatchOf(id, "author", "cheap")));
    await run((prog) => prog.submit(id));
    await run((prog) => prog.assignReview(id, dispatchOf(id, "review", "dear", "c1")));

    await run((prog) => prog.release(id));
    const after = await run((prog) => prog.show(id));

    expect(after.status).toBe("open");
    expect(after.runs.map((r) => [r.role, r.open, r.ending])).toEqual([
      ["author", false, "handed-off"],
      ["review", false, "released"],
    ]);
  });

  // A retried review replaces a reviewer that vanished, so the lap holds one open review run.
  test("assigning a reviewer ends the review run it replaces as released", async () => {
    const id = (await Bun.$`prog add "vanished reviewer" -p foreman`.text()).trim();
    await run((prog) => prog.attribute(id, dispatchOf(id, "author", "cheap")));
    await run((prog) => prog.submit(id));
    await run((prog) => prog.assignReview(id, dispatchOf(id, "review", "cheap", "c1")));
    await run((prog) => prog.assignReview(id, dispatchOf(id, "review", "dear", "c1")));

    const after = await run((prog) => prog.show(id));
    expect(after.runs.map((r) => [r.role, r.rung, r.open, r.ending])).toEqual([
      ["author", "cheap", false, "handed-off"],
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

    const children = await run((prog) => prog.children(epic));

    expect(children.map((child) => child.status).sort()).toEqual(["blocked", "draft", "proposed"]);
  });

  // A correction round counts against the author who received it, so the next
  // author's trial row must not inherit it.
  test("counts correction rounds on the author run, even after its handoff, and a new author starts at none", async () => {
    const id = (await Bun.$`prog add "corrected" -p foreman`.text()).trim().split("\n")[0]!;
    await run((prog) => prog.attribute(id, dispatchOf(id, "author", "cheap")));

    expect(await run((prog) => prog.countRound(id))).toBe(1);
    await run((prog) => prog.submit(id));
    await run((prog) => prog.assignReview(id, dispatchOf(id, "review", "dear", "c1")));
    expect(await run((prog) => prog.countRound(id))).toBe(2);
    expect(roundsOf(await run((prog) => prog.show(id)))).toBe(2);
    await run((prog) => prog.release(id));
    await run((prog) => prog.attribute(id, dispatchOf(id, "author", "cheap")));

    const after = await run((prog) => prog.show(id));
    expect(roundsOf(after)).toBe(0);
    expect(after.labels).toEqual([]);
    expect(after.runs.at(-1)).toMatchObject({ role: "author", rung: "cheap", open: true });
  });

  test("names the operation a store failure came from", async () => {
    const error = await run((prog) =>
      Effect.flip(prog.complete({ id: "ts-does-not-exist", labels: [] })),
    );

    expect(error.command).toBe("done ts-does-not-exist");
    expect(error.detail).toContain("not found");
  });

  test("submits a done task with an unread branch for review", async () => {
    const id = (await Bun.$`prog add "unread branch" -p foreman`.text()).trim();
    await Bun.$`prog done ${id}`.quiet();

    await run((prog) => prog.submit(id));
    const after = await run((prog) => prog.show(id));

    expect(after.status).toBe("reviewing");
  });
});
