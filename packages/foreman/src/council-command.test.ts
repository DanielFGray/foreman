import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { councilCommand } from "./council-command.ts";
import { ladderCommand } from "./ladder-command.ts";
import { readCouncil, readModels, setCouncil } from "./registry.ts";
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

const council = (...args: ReadonlyArray<string>) =>
  Command.runWith(councilCommand, { version: "test" })(args).pipe(
    Effect.provide(BunServices.layer),
  );
const ladder = (...args: ReadonlyArray<string>) =>
  Command.runWith(ladderCommand, { version: "test" })(args).pipe(Effect.provide(BunServices.layer));

afterEach(() => {
  process.exitCode = 0;
});

describe("the council", () => {
  test("starts empty, and add and remove change one model's switch", () =>
    withStore(
      rig,
      Effect.gen(function* () {
        expect(yield* readCouncil).toEqual([]);
        yield* council("add", "opencode/claude-sonnet-5");
        yield* council("add", "opencode-go/ox-alpha-free");
        yield* council("remove", "opencode-go/ox-alpha-free");
        expect((yield* readCouncil).map((member) => member.model)).toEqual([
          "opencode/claude-sonnet-5",
        ]);
      }),
    ));

  test("refuses a model with no row in the models table", () =>
    withStore(
      rig,
      Effect.gen(function* () {
        const error = yield* Effect.flip(setCouncil("nobody/none", true));
        expect(error.detail).toMatch(/no row in the models table/);
      }),
    ));

  test("--json prints each member with its harness and launch arguments", () =>
    withStore(
      rig + "\nUPDATE models SET council = 1 WHERE model = 'opencode/claude-sonnet-5';\n",
      Effect.gen(function* () {
        expect(yield* printed(council("--json"))).toEqual([
          {
            model: "opencode/claude-sonnet-5",
            harness: "opencode",
            thinking: "medium",
            tier: "metered",
            args: ["--model", "opencode/claude-sonnet-5"],
          },
        ]);
      }),
    ));
});

describe("foreman ladder --json", () => {
  test("prints the rungs in rank order and every model with its council switch", () =>
    withStore(
      rig + "\nUPDATE models SET council = 1 WHERE model = 'opencode/claude-sonnet-5';\n",
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
        expect(
          document.models
            .filter((model: { council: boolean }) => model.council)
            .map((model: { model: string }) => model.model),
        ).toEqual(["opencode/claude-sonnet-5"]);
      }),
    ));
});
