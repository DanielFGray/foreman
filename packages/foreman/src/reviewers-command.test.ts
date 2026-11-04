import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { ladderCommand } from "./ladder-command.ts";
import { readModels, readReviewers, removeReviewer } from "./registry.ts";
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

  test("add takes the model's thinking level unless one is given", () =>
    withStore(
      rig,
      Effect.gen(function* () {
        yield* reviewers("add", "opencode/claude-sonnet-5");
        yield* reviewers("add", "opencode/claude-sonnet-5", "--name", "deep", "--thinking", "high");
        expect((yield* readReviewers).map((one) => [one.name, one.thinking])).toEqual([
          ["deep", "high"],
          ["opencode/claude-sonnet-5", "medium"],
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
            tier: "metered",
            provider: "opencode",
            args: ["--model", "opencode/claude-sonnet-5"],
          },
        ]);
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
            rung["tier"],
            rung["enabled"],
            rung["state"],
          ]),
        ).toEqual([
          ["cheap", "opencode/deepseek-v4-pro", "metered", true, "trial"],
          ["strong", "opencode/claude-sonnet-5", "metered", true, "trial"],
          ["promo", "opencode-go/ox-alpha-free", "free", true, "trial"],
        ]);
        expect(document.models).toEqual((yield* readModels).map((model) => ({ ...model })));
        expect(document.reviewers.map((one: { name: string }) => one.name)).toEqual(["sonnet"]);
      }),
    ));
});
