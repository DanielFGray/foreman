import { afterEach, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { EMPTY_LADDER, readLadder, readModels, readReviewers } from "./registry.ts";
import { ladderCommand } from "./ladder-command.ts";
import { modelsCommand } from "./models-command.ts";
import { reviewersCommand } from "./reviewers-command.ts";
import { withStore } from "./scratch-store.ts";

const models = (...args: ReadonlyArray<string>) =>
  Command.runWith(modelsCommand, { version: "test" })(args).pipe(
    Effect.provide(BunServices.layer),
  );
const ladder = (...args: ReadonlyArray<string>) =>
  Command.runWith(ladderCommand, { version: "test" })(args).pipe(Effect.provide(BunServices.layer));
const reviewers = (...args: ReadonlyArray<string>) =>
  Command.runWith(reviewersCommand, { version: "test" })(args).pipe(
    Effect.provide(BunServices.layer),
  );

afterEach(() => {
  process.exitCode = 0;
});

describe("foreman models add", () => {
  test("seeds a pool and model so ladder and reviewers add can run on an empty store", () =>
    withStore(
      "",
      Effect.gen(function* () {
        expect(yield* readModels).toEqual([]);
        const empty = yield* Effect.flip(readLadder);
        expect(empty.detail).toBe(EMPTY_LADDER);

        yield* models(
          "add",
          "opencode/deepseek-v4-pro",
          "--harness",
          "opencode",
          "--provider",
          "opencode",
          "--pool",
          "OpenCode Zen",
        );
        expect(yield* readModels).toEqual([
          { model: "opencode/deepseek-v4-pro", harness: "opencode", retired: false },
        ]);

        yield* ladder("add", "cheap", "opencode/deepseek-v4-pro", "--thinking", "medium");
        expect((yield* readLadder).map((rung) => rung.name)).toEqual(["cheap"]);

        yield* reviewers("add", "opencode/deepseek-v4-pro");
        expect((yield* readReviewers).map((one) => one.name)).toEqual([
          "opencode/deepseek-v4-pro",
        ]);
      }),
    ));

  test("reuses an existing pool and refuses a model already listed", () =>
    withStore(
      "",
      Effect.gen(function* () {
        yield* models(
          "add",
          "opencode/a",
          "--harness",
          "opencode",
          "--provider",
          "opencode",
          "--pool",
          "Shared",
        );
        yield* models(
          "add",
          "opencode/b",
          "--harness",
          "opencode",
          "--provider",
          "opencode",
          "--pool",
          "Shared",
        );
        expect((yield* readModels).map((one) => one.model)).toEqual([
          "opencode/a",
          "opencode/b",
        ]);
        const taken = yield* Effect.flip(
          models(
            "add",
            "opencode/a",
            "--harness",
            "opencode",
            "--provider",
            "opencode",
            "--pool",
            "Shared",
          ),
        );
        expect(String(taken)).toMatch(/already listed/);
      }),
    ));
});
