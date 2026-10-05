import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { Item } from "./prog.ts";
import { appendTo, closes, poolFor, trialFor } from "./trials.ts";

const task = (overrides: Partial<Item> = {}) =>
  ({
    id: "ts-1",
    title: "Measure the stack-safety candidates",
    project: "quill",
    labels: [],
    status: "reviewing",
    ...overrides,
  }) as unknown as Item;

const run = (overrides: Partial<Parameters<typeof trialFor>[0]> = {}) => ({
  task: task(),
  branch: "foreman/ts-1",
  harness: "opencode",
  model: "opencode-go/deepseek-v4-flash",
  provider: "opencode-go",
  role: "author" as const,
  phase: "Unfinished" as const,
  ...overrides,
});

describe("poolFor", () => {
  test("names an account as the trials table spells it", () => {
    expect(poolFor("openai")).toBe("OpenAI");
    expect(poolFor("opencode-go")).toBe("OpenCode Go");
    expect(poolFor("opencode")).toBe("OpenCode Zen");
    expect(poolFor("claude")).toBe("Anthropic");
  });

  test("writes an account it has no name for as itself", () => {
    // A wrong pool name is worse than a key nobody recognises: it silently
    // splits one account's history into two.
    expect(poolFor("brand-new")).toBe("brand-new");
  });
});

describe("closes", () => {
  test("a live agent and an unread review have not ended", () => {
    // foreman closed a coach window, not a run; a row here would say work
    // finished while the agent is still holding it.
    expect(closes("Blocked")).toBe(false);
    expect(closes("ReviewWaiting")).toBe(false);
    expect(closes("ReviewExpired")).toBe(false);
  });

  test("every ending a run can reach is a close", () => {
    expect(closes("Landed")).toBe(true);
    expect(closes("ReviewReturned")).toBe(true);
    expect(closes("VanishedEmpty")).toBe(true);
    expect(closes("Unfinished")).toBe(true);
  });
});

describe("trialFor", () => {
  test("states the run foreman derived and nothing it did not", () => {
    expect(trialFor(run())).toEqual({
      project: "quill",
      task: "ts-1",
      slice: "Measure the stack-safety candidates",
      kind: "opencode",
      pool: "OpenCode Go",
      model: "opencode-go/deepseek-v4-flash",
      work: "build",
      // A stop without a verdict is a hand-off, not a drop: foreman cannot tell
      // a crash from an agent that lost track, and neither can the table.
      outcome: "handed-off",
      source: "live",
      evidence: "foreman/ts-1",
      notes: "Unfinished",
    });
  });

  test("writes no row for a run that has not ended", () => {
    expect(trialFor(run({ phase: "Blocked" }))).toBeUndefined();
  });

  test("lands a report as answered and code as committed", () => {
    expect(trialFor(run({ phase: "Landed" }))?.outcome).toBe("committed");
    expect(trialFor(run({ phase: "Landed", task: task({ labels: ["research"] }) }))).toMatchObject({
      outcome: "answered",
      work: "research",
    });
  });

  test("records a review as review, and a rejection as a hand-off", () => {
    expect(trialFor(run({ role: "review", phase: "ReviewReturned" }))).toMatchObject({
      work: "review",
      outcome: "handed-off",
    });
  });

  test("drops what a person canceled", () => {
    expect(trialFor(run({ phase: "Canceled" }))?.outcome).toBe("dropped");
  });

  test("names the harness when the account cannot be read", () => {
    // A rung with no derivable provider still ran; the harness is the honest
    // pool rather than an account foreman invented.
    expect(trialFor(run({ provider: undefined, model: undefined }))).toMatchObject({
      pool: "opencode",
      model: "opencode",
    });
  });
});

/** The coordinator's table as it stands, so a row has to fit it as it is. */
const SCHEMA = `
  CREATE TABLE trials (
    id INTEGER PRIMARY KEY,
    closed_at TEXT NOT NULL DEFAULT (datetime('now')),
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    slice TEXT NOT NULL,
    kind TEXT NOT NULL,
    pool TEXT NOT NULL,
    model TEXT NOT NULL,
    work TEXT NOT NULL CHECK (work IN ('build', 'correction', 'research', 'review')),
    outcome TEXT NOT NULL CHECK (outcome IN ('committed', 'dropped', 'handed-off', 'answered')),
    rounds INTEGER,
    report_accurate INTEGER CHECK (report_accurate IN (0, 1)),
    source TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'backfill')),
    evidence TEXT,
    notes TEXT
  );
  CREATE TABLE defects (
    trial_id INTEGER NOT NULL REFERENCES trials(id),
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
  );
`;

describe("the trials writer", () => {
  const scratch = () => {
    const directory = mkdtempSync(join(tmpdir(), "foreman-trials-"));
    return { directory, path: join(directory, "model-trials.db") };
  };

  /** The sqlite CLI, because bun refuses a second handle on one file. */
  const sqlite = (path: string, sql: string): string => {
    const done = Bun.spawnSync(["sqlite3", "-json", path, sql], { stderr: "pipe" });
    return new TextDecoder().decode(done.stdout).trim();
  };

  const rows = (path: string, sql = "SELECT * FROM trials"): Array<Record<string, unknown>> =>
    JSON.parse(sqlite(path, sql) || "[]");

  test("appends a row the coordinator's own schema accepts", async () => {
    const { directory, path } = scratch();
    sqlite(path, SCHEMA);

    await Effect.runPromise(appendTo(path)(trialFor(run({ phase: "Landed" }))!));

    const written = rows(path);
    rmSync(directory, { recursive: true, force: true });

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      project: "quill",
      task: "ts-1",
      pool: "OpenCode Go",
      model: "opencode-go/deepseek-v4-flash",
      work: "build",
      outcome: "committed",
      source: "live",
    });
    // The two judgements foreman cannot make are absent, not invented.
    expect(written[0]?.["rounds"]).toBeNull();
    expect(written[0]?.["report_accurate"]).toBeNull();
  });

  test("skips a machine with no trials database rather than creating one", async () => {
    // Nothing here may throw: a missing file is the ordinary state of a machine
    // that has never run the herd skill, and a row must not be the reason a tick
    // dies.
    const { directory, path } = scratch();
    await Effect.runPromise(appendTo(path)(trialFor(run())!));

    expect(existsSync(path)).toBe(false);
    rmSync(directory, { recursive: true, force: true });
  });

  test("survives a file that is not a database at all", async () => {
    const { directory, path } = scratch();
    await Bun.write(path, "not a database");
    await Effect.runPromise(appendTo(path)(trialFor(run())!));

    expect(await Bun.file(path).text()).toBe("not a database");
    rmSync(directory, { recursive: true, force: true });
  });

  test("survives a database whose table has moved on", async () => {
    const { directory, path } = scratch();
    sqlite(path, "CREATE TABLE something_else (id INTEGER)");

    await Effect.runPromise(appendTo(path)(trialFor(run())!));

    expect(rows(path, "SELECT count(*) AS n FROM something_else")[0]?.["n"]).toBe(0);
    rmSync(directory, { recursive: true, force: true });
  });
});
