import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import {
  checkFlags,
  handRunFor,
  modelOf,
  registeredOf,
  type HandTerminal,
  type RawFlags,
} from "./runs-record.ts";

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

describe("modelOf", () => {
  test("reads the model after --model in the launch argv, before the flag", async () => {
    const model = await Effect.runPromise(modelOf(terminal(), Option.some("opencode-go/kimi")));
    expect(model).toBe("openai-codex/gpt-5.6-luna");
  });

  test("falls back to the --model flag when the argv names none", async () => {
    const model = await Effect.runPromise(
      modelOf(
        terminal({ foreground: { argv: ["/usr/bin/claude"] } }),
        Option.some("opencode-go/kimi"),
      ),
    );
    expect(model).toBe("opencode-go/kimi");
  });

  test("refuses when neither the argv nor the flag names a model", async () => {
    const refusal = await Effect.runPromise(
      modelOf(terminal({ foreground: { argv: ["/usr/bin/claude"] } }), Option.none()).pipe(
        Effect.flip,
      ),
    );
    expect(refusal.detail).toBe(
      "no --model in the launch argv of t7; pass --model <provider/model>",
    );
  });
});

describe("registeredOf", () => {
  test("takes the pool and harness of the model's registry row", async () => {
    const row = await Effect.runPromise(
      registeredOf("claude-opus-5-5", Option.some({ pool: "Anthropic", harness: "claude" })),
    );
    expect(row).toEqual({ pool: "Anthropic", harness: "claude" });
  });

  test("refuses a model with no registry row, naming the command that adds it", async () => {
    const refusal = await Effect.runPromise(
      registeredOf("openai-codex/gpt-5.6-luna", Option.none()).pipe(Effect.flip),
    );
    expect(refusal.detail).toBe(
      "model openai-codex/gpt-5.6-luna has no row in the models table; add it before recording its run: foreman models add openai-codex/gpt-5.6-luna --harness <kind> --provider <id> --pool <name>",
    );
  });
});

describe("handRunFor", () => {
  test("takes the task, harness, pool, model and start from the terminal and the registry", async () => {
    const checked = await Effect.runPromise(checkFlags(flags()));
    const run = handRunFor({
      terminal: terminal(),
      task,
      flags: checked,
      model: "openai-codex/gpt-5.6-luna",
      registered: { pool: "OpenAI Codex", harness: "pi" },
      closedAt: new Date("2026-11-16T10:30:00.000Z"),
    });
    expect(run).toEqual({
      project: "quill",
      task: "ts-1",
      slice: "lazy service defaults",
      kind: "pi",
      pool: "OpenAI Codex",
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
});

describe("modelOf refusals", () => {
  test("refuses a terminal whose agent has ended, since its argv is gone", async () => {
    const refusal = await Effect.runPromise(
      modelOf(terminal({ foreground: null }), Option.none()).pipe(Effect.flip),
    );
    expect(refusal.detail).toBe("terminal t7 runs no program; start its agent first");
  });
});
