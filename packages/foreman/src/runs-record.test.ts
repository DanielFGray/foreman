import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { checkFlags, handRunFor, type HandTerminal, type RawFlags } from "./runs-record.ts";

const flags = (over: Partial<RawFlags> = {}): RawFlags => ({
  work: "build",
  outcome: "committed",
  size: 2,
  rounds: 1,
  accurate: true,
  inaccurate: false,
  model: Option.none(),
  notes: Option.none(),
  defects: [],
  ...over,
});

const refusalOf = (raw: RawFlags) => Effect.runPromise(checkFlags(raw).pipe(Effect.flip));

const terminal = (over: Partial<HandTerminal> = {}): HandTerminal => ({
  address: "t7",
  created_ms: Date.UTC(2026, 10, 16, 10, 0, 0),
  labels: { "fm.task": "ts-1" },
  foreground: {
    argv: ["/usr/bin/pi", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "medium"],
  },
  ...over,
});

const task = { id: "ts-1", project: "quill", title: "lazy service defaults" };

describe("checkFlags", () => {
  test("refuses a work value outside the list, and names the list", async () => {
    const refusal = await refusalOf(flags({ work: "diagnose" }));
    expect(refusal.detail).toBe(
      '--work must be one of: build, correction, research, review (got "diagnose")',
    );
  });

  test("refuses an outcome outside the list, and names the list", async () => {
    const refusal = await refusalOf(flags({ outcome: "escalated" }));
    expect(refusal.detail).toBe(
      '--outcome must be one of: committed, dropped, handed-off, answered (got "escalated")',
    );
  });

  test("refuses a defect kind outside the list, and names the list", async () => {
    const refusal = await refusalOf(flags({ defects: ["logic:wrong branch"] }));
    expect(refusal.detail).toContain("--defect must be one of: patch-around-wall, missed-caller");
    expect(refusal.detail).toContain('(got "logic")');
  });

  test("refuses a defect with no detail", async () => {
    const refusal = await refusalOf(flags({ defects: ["duplication:"] }));
    expect(refusal.detail).toBe("--defect duplication: needs a detail after the kind: kind:detail");
  });

  test("refuses both accuracy flags, and neither", async () => {
    expect((await refusalOf(flags({ inaccurate: true }))).detail).toBe(
      "give exactly one of --accurate or --inaccurate",
    );
    expect((await refusalOf(flags({ accurate: false }))).detail).toBe(
      "give exactly one of --accurate or --inaccurate",
    );
  });

  test("accepts a well-formed set and splits each defect at its first colon", async () => {
    const checked = await Effect.runPromise(
      checkFlags(flags({ defects: ["duplication:parser: re-implemented it"] })),
    );
    expect(checked.work).toBe("build");
    expect(checked.defects).toEqual([{ kind: "duplication", detail: "parser: re-implemented it" }]);
  });
});

describe("handRunFor", () => {
  test("takes the task, harness, model and start from the terminal", async () => {
    const checked = await Effect.runPromise(checkFlags(flags()));
    const run = await Effect.runPromise(
      handRunFor({
        terminal: terminal(),
        task,
        flags: checked,
        closedAt: new Date("2026-11-16T10:30:00.000Z"),
      }),
    );
    expect(run).toEqual({
      project: "quill",
      task: "ts-1",
      slice: "lazy service defaults",
      kind: "pi",
      pool: "openai-codex",
      model: "openai-codex/gpt-5.6-luna",
      work: "build",
      outcome: "committed",
      startedAt: new Date(Date.UTC(2026, 10, 16, 10, 0, 0)),
      closedAt: new Date("2026-11-16T10:30:00.000Z"),
      rounds: 1,
      size: 2,
      reportAccurate: true,
      notes: undefined,
      defects: [],
    });
  });

  test("takes the model flag when the launch argv names none", async () => {
    const checked = await Effect.runPromise(
      checkFlags(flags({ model: Option.some("opencode-go/kimi") })),
    );
    const run = await Effect.runPromise(
      handRunFor({
        terminal: terminal({ foreground: { argv: ["/usr/bin/claude", "--no-chrome"] } }),
        task,
        flags: checked,
        closedAt: new Date(0),
      }),
    );
    expect(run.kind).toBe("claude");
    expect(run.model).toBe("opencode-go/kimi");
  });

  test("refuses a terminal with no model anywhere, and one that runs no program", async () => {
    const checked = await Effect.runPromise(checkFlags(flags()));
    const noModel = await Effect.runPromise(
      handRunFor({
        terminal: terminal({ foreground: { argv: ["/usr/bin/claude"] } }),
        task,
        flags: checked,
        closedAt: new Date(0),
      }).pipe(Effect.flip),
    );
    expect(noModel.detail).toBe(
      "no --model in the launch argv of t7; pass --model <provider/model>",
    );
    const noProgram = await Effect.runPromise(
      handRunFor({
        terminal: terminal({ foreground: null }),
        task,
        flags: checked,
        closedAt: new Date(0),
      }).pipe(Effect.flip),
    );
    expect(noProgram.detail).toBe("terminal t7 runs no program; start its agent first");
  });
});
