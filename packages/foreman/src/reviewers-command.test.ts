import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { harnessLaunch } from "./harness.ts";
import { ladderCommand } from "./ladder-command.ts";
import { readLadder, readModels, readReviewers, readRows, removeReviewer } from "./registry.ts";
import { reviewersCommand } from "./reviewers-command.ts";
import { withStore } from "./scratch-store.ts";

const rig = readFileSync(join(import.meta.dir, "..", "e2e", "registry.sql"), "utf8");

/** What a command prints, parsed as JSON. */
const printed = <E, R>(command: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      yield* command;
      return JSON.parse(log.mock.calls.map((call) => call.join(" ")).join("\n"));
    } finally {
      log.mockRestore();
    }
  });

const reviewers = (...args: ReadonlyArray<string>) =>
  Command.runWith(reviewersCommand, { version: "test" })(args).pipe(
    Effect.provide(BunServices.layer),
  );
const ladder = (...args: ReadonlyArray<string>) =>
  Command.runWith(ladderCommand, { version: "test" })(args).pipe(Effect.provide(BunServices.layer));

afterEach(() => {
  process.exitCode = 0;
});

describe("the reviewers", () => {
  test("start empty, and add and remove change the list", () =>
    withStore(
      rig,
      Effect.gen(function* () {
        expect(yield* readReviewers).toEqual([]);
        yield* reviewers("add", "opencode/claude-sonnet-5");
        yield* reviewers("add", "opencode-go/ox-alpha-free", "--name", "ox");
        yield* reviewers("remove", "ox");
        expect((yield* readReviewers).map((one) => one.name)).toEqual(["opencode/claude-sonnet-5"]);
      }),
    ));

  test("add takes the level given, and none when none is given", () =>
    withStore(
      rig,
      Effect.gen(function* () {
        yield* reviewers("add", "opencode/claude-sonnet-5");
        yield* reviewers("add", "opencode/claude-sonnet-5", "--name", "deep", "--thinking", "high");
        expect((yield* readReviewers).map((one) => [one.name, one.thinking])).toEqual([
          ["deep", "high"],
          ["opencode/claude-sonnet-5", undefined],
        ]);
      }),
    ));

  test("refuses a model with no row in the models table, a taken name, and an unknown name", () =>
    withStore(
      rig,
      Effect.gen(function* () {
        const unknown = yield* Effect.flip(reviewers("add", "nobody/none"));
        expect(String(unknown)).toMatch(/no row in the models table/);
        yield* reviewers("add", "opencode/claude-sonnet-5");
        const taken = yield* Effect.flip(reviewers("add", "opencode/claude-sonnet-5"));
        expect(String(taken)).toMatch(/already listed/);
        const error = yield* Effect.flip(removeReviewer("nobody"));
        expect(error.detail).toMatch(/no reviewer nobody; reviewers: opencode\/claude-sonnet-5/);
      }),
    ));

  test("--json prints each reviewer with its harness, account and launch arguments", () =>
    withStore(
      rig +
        "\nINSERT INTO reviewers (reviewer, model, thinking) VALUES ('sonnet', 'opencode/claude-sonnet-5', 'high');\n",
      Effect.gen(function* () {
        expect(yield* printed(reviewers("--json"))).toEqual([
          {
            name: "sonnet",
            model: "opencode/claude-sonnet-5",
            harness: "opencode",
            thinking: "high",
            provider: "opencode",
            args: ["--model", "opencode/claude-sonnet-5"],
          },
        ]);
      }),
    ));
});

/** Two harnesses that take a thinking flag, for rungs whose levels show in their launch. */
const flagged = `${rig}
INSERT INTO models(model, provider, pool, harness, limit_scope) VALUES
  ('opus', 'anthropic', 'OpenCode Zen', 'claude', 'pool'),
  ('gpt-6.1-sol', 'openai', 'OpenCode Zen', 'codex', 'pool');
`;

/** The argv each enabled rung's harness starts with, by rung name. */
const launches = readLadder.pipe(
  Effect.map((rungs) =>
    Object.fromEntries(
      rungs.map((rung) => [
        rung.name,
        harnessLaunch({
          kind: rung.harness,
          model: rung.model,
          thinking: rung.thinking,
          prompt: "go",
          directory: "/w",
        }).argv,
      ]),
    ),
  ),
);

describe("a rung's thinking level", () => {
  test("two rungs of one model at different levels launch with different flags", () =>
    withStore(
      flagged,
      Effect.gen(function* () {
        yield* ladder("add", "opus-low", "opus", "--thinking", "low");
        yield* ladder("add", "opus-high", "opus", "--thinking", "high", "--above", "opus-low");
        yield* ladder("add", "sol-low", "gpt-6.1-sol", "--thinking", "low");
        yield* ladder("add", "sol-high", "gpt-6.1-sol", "--thinking", "high");
        const argv = yield* launches;
        expect(argv["opus-low"]).toEqual(["claude", "--model", "opus", "--effort", "low", "go"]);
        expect(argv["opus-high"]).toEqual(["claude", "--model", "opus", "--effort", "high", "go"]);
        expect(argv["sol-low"]).toEqual([
          "codex",
          "--no-daemon",
          "--model",
          "gpt-6.1-sol",
          "-c",
          "model_reasoning_effort=low",
          "go",
        ]);
        expect(argv["sol-high"]).toContain("model_reasoning_effort=high");
      }),
    ));

  test("a rung with no level passes no thinking flag", () =>
    withStore(
      flagged,
      Effect.gen(function* () {
        yield* ladder("add", "opus-plain", "opus");
        yield* ladder("add", "opus-set", "opus", "--thinking", "medium");
        yield* ladder("thinking", "opus-set", "none");
        const argv = yield* launches;
        expect(argv["opus-plain"]).toEqual(["claude", "--model", "opus", "go"]);
        expect(argv["opus-set"]).toEqual(["claude", "--model", "opus", "go"]);
      }),
    ));

  test("ladder thinking sets one rung's level and leaves the others", () =>
    withStore(
      flagged,
      Effect.gen(function* () {
        yield* ladder("add", "opus-a", "opus", "--thinking", "low");
        yield* ladder("add", "opus-b", "opus", "--thinking", "low");
        yield* ladder("thinking", "opus-a", "high");
        const levels = Object.fromEntries((yield* readRows).map((row) => [row.rung, row.thinking]));
        expect(levels).toMatchObject({ "opus-a": "high", "opus-b": "low", cheap: "medium" });
      }),
    ));
});

describe("foreman ladder --json", () => {
  test("prints the rungs in rank order, every model, and the reviewers", () =>
    withStore(
      rig +
        "\nINSERT INTO reviewers (reviewer, model, thinking) VALUES ('sonnet', 'opencode/claude-sonnet-5', 'high');\n",
      Effect.gen(function* () {
        const document = yield* printed(ladder("--json"));
        expect(
          document.rungs.map((rung: Record<string, unknown>) => [
            rung["rung"],
            rung["model"],
            rung["enabled"],
            rung["state"],
          ]),
        ).toEqual([
          ["cheap", "opencode/deepseek-v4-pro", true, "trial"],
          ["strong", "opencode/claude-sonnet-5", true, "trial"],
          ["promo", "opencode-go/ox-alpha-free", true, "trial"],
        ]);
        expect(document.models).toEqual((yield* readModels).map((model) => ({ ...model })));
        expect(document.reviewers.map((one: { name: string }) => one.name)).toEqual(["sonnet"]);
      }),
    ));
});
