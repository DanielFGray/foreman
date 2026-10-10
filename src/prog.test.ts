import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Prog } from "./prog.ts";
import {
  agentLog,
  attemptsOf,
  authoredBy,
  isApproved,
  isPinned,
  reviewedBy,
  type Item,
} from "./prog.ts";

const run = <A, E>(f: (prog: Prog["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Prog.use(f).pipe(Effect.provide(Prog.Default)));

const item = (labels: ReadonlyArray<string>): Item => ({
  id: "ts-123456",
  title: "Test task",
  status: "reviewing",
  project: "foreman",
  type: "task",
  priority: 1,
  labels,
  description: null,
  last_activity_at: new Date(),
  created_at: new Date(),
});

describe("task attribution", () => {
  test("keeps author and current reviewer distinct", () => {
    const task = item(["by:opencode", "review-by:claude", "approved"]);

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

describe("focus label", () => {
  test("recognises a focused item", () => {
    expect(isPinned(item(["pin"]))).toBe(true);
    expect(isPinned(item(["plan"]))).toBe(false);
  });
});

describe("unfinished attempts on a rung", () => {
  test("reads zero for a rung that was never tried", () => {
    expect(attemptsOf(item([]), "deepseek")).toBe(0);
    expect(attemptsOf(item(["by:opencode"]), "deepseek")).toBe(0);
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

describe("clearReview against a live store", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "foreman-prog-"));
    process.env.PROG_DB = join(directory, "prog.db");
    await Bun.$`prog init`.quiet();
  });

  afterAll(async () => {
    delete process.env.PROG_DB;
    await rm(directory, { recursive: true, force: true });
  });

  // A reviewer can approve and then return the work in one turn, and the
  // settle loop's ReviewReturned path clears the review through this method.
  // The verdict must go with it, or the task returns to the queue pre-approved
  // and the next author's handoff lands without anyone having read the new
  // diff.
  test("clears the verdict alongside reviewer ownership", async () => {
    const id = (
      await Bun.$`prog add "returned approval" -p foreman -l approved -l review-by-x`.text()
    ).trim();

    await run((prog) => prog.clearReview(id));
    const after = await run((prog) => prog.show(id));

    expect(after.labels).not.toContain("approved");
    expect(after.labels).not.toContain("review-by:x");
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
  test("counts correction rounds and resets them for a new author", async () => {
    const id = (await Bun.$`prog add "corrected" -p foreman`.text()).trim().split("\n")[0]!;

    expect(await run((prog) => prog.countRound(id))).toBe(1);
    expect(await run((prog) => prog.countRound(id))).toBe(2);
    await run((prog) => prog.attribute(id, "cheap"));

    const after = await run((prog) => prog.show(id));
    expect(after.labels).toEqual(["by:cheap"]);
  });

  test("leaves a task that never carried the labels untouched", async () => {
    const id = (await Bun.$`prog add "plain return" -p foreman`.text()).trim();

    await run((prog) => prog.clearReview(id));
    const after = await run((prog) => prog.show(id));

    expect(after.labels).toEqual([]);
  });
});

describe("command failures", () => {
  test("reports a non-zero prog exit status", async () => {
    const error = await run((prog) => Effect.flip(prog.complete("ts-does-not-exist")));

    expect(error.command).toContain("done ts-does-not-exist");
  });
});
