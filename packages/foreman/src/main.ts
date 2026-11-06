#!/usr/bin/env bun
import { CliError, Command, Flag } from "effect/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, FileSystem, Layer, Logger, Runtime } from "effect";
import { Runs, store } from "tasks";
import { settings, Settings } from "./config.ts";
import { Registry } from "./registry.ts";
import { resetsLabel, quotaJson, usedLabel } from "./format.ts";
import { dispatchable, providerOf, providersOf, rungsOn } from "./ladder.ts";
import { exhausted, freeAt, Quota } from "./quota.ts";
import { VERSION } from "./telemetry.ts";
import { ladderCommand } from "./ladder-command.ts";
import { modelsCommand } from "./models-command.ts";
import { reviewersCommand } from "./reviewers-command.ts";
import { stats } from "./stats.ts";
import { subcommands } from "./commands.ts";
import { pipelineCommand } from "./pipeline-command.ts";
import { policyCommand } from "./policy-command.ts";
import { linearCommand } from "./linear-auth.ts";
import {
  listCommand,
  logCommand,
  queueCommand,
  runsCommand,
  showCommand,
} from "./store-commands.ts";
import { scheduleCommand } from "./schedule-command.ts";
import { services, storeServices } from "./host.ts";
import { serveCommand } from "./serve.ts";

/**
 * The command line. `foreman serve` runs the dispatcher (`serve.ts`); every
 * other command here acts once on the same world and exits.
 */

/**
 * What every account behind the ladder has left, without starting anything.
 *
 * This is the question asked before starting the fleet: whether there is any
 * point today, and which rungs are stopped. One `Quota` behind this and the
 * dispatcher's own reading — two callers, not two readings.
 */
const json = Flag.Boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Emit the report as JSON, every reset an absolute ISO instant"),
);

const quotaCommand = Command.make("quota", { json }, ({ json }) =>
  Effect.gen(function* () {
    const config = yield* Settings;
    const quota = yield* Quota;

    const blind = dispatchable(config.ladder)
      .filter((rung) => providerOf(rung) === undefined)
      .map((rung) => rung.name);
    const rungsOf = (provider: string) => rungsOn(config.ladder, provider);

    const readings = yield* Effect.forEach(
      providersOf(config.ladder, config.reviewers),
      (provider) =>
        quota.usage(provider).pipe(
          Effect.map((usage) => ({ _tag: "usage", provider, usage }) as const),
          Effect.catchTag("QuotaError", (error) =>
            Effect.succeed({
              _tag: "unreadable",
              provider,
              detail: error.detail,
            } as const),
          ),
        ),
      { concurrency: "unbounded" },
    );

    if (json) {
      yield* Console.log(quotaJson(blind, readings, rungsOf));
      return;
    }

    if (blind.length > 0) {
      yield* Console.log(
        `no provider derivable for ${blind.join(", ")} — add "provider" to each rung to have its quota read`,
      );
    }

    for (const reading of readings) {
      if (reading._tag === "usage") {
        const resets = freeAt(reading.usage);
        const width = Math.max(...reading.usage.allowances.map((a) => a.window.length));
        yield* Console.log(
          [
            // The rungs are named only when the account stops them: that list
            // is what to move off it, and an account with room stops nothing.
            `${reading.provider}${reading.usage.plan === undefined ? "" : ` [${reading.usage.plan}]`}  ${exhausted(reading.usage) ? `OUT OF QUOTA — resets ${resets === undefined ? "unknown" : resetsLabel(resets)}  stops ${rungsOf(reading.provider).join(", ")}` : "ok"}`,
            ...reading.usage.allowances.map(
              (allowance) =>
                `    ${allowance.window.padEnd(width)}  ${usedLabel(allowance.usedPercent).padStart(4)} used   resets ${allowance.resetsAt === undefined ? "unknown" : resetsLabel(allowance.resetsAt)}`,
            ),
          ].join("\n"),
        );
      } else {
        // Unreadable is not spent. The dispatcher dispatches such a rung anyway,
        // so this must say the same thing rather than read as a wall.
        yield* Console.log(`${reading.provider}  unreadable: ${reading.detail}`);
      }
    }
  }).pipe(Effect.provide(Layer.mergeAll(Quota.Default, settings).pipe(Layer.provide(store)))),
).pipe(
  Command.withDescription(
    "Report how much of each provider's allowance the ladder has left, and which rungs are stopped",
  ),
);

const statsCommand = Command.make("stats", {}, () => stats).pipe(
  Command.withDescription("Render the runs table as a self-contained HTML report of fleet metrics"),
);

/**
 * How to drive foreman by hand, for an agent coordinating a fleet. Printed
 * rather than installed as a skill file, so it ships with the binary it
 * describes and cannot fall behind it.
 */
const skill = Flag.Boolean("skill").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print how to drive foreman's lifecycle by hand, then exit"),
);

const printSkill = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) => fs.readFileString(`${import.meta.dir}/skill.md`)),
  Effect.flatMap(Console.log),
);

const foreman = Command.make("foreman", { skill }, ({ skill }) =>
  Effect.gen(function* () {
    if (skill) return yield* printSkill;
    return yield* new CliError.ShowHelp({ commandPath: ["foreman"], errors: [] });
  }),
).pipe(
  Command.withSubcommands([
    serveCommand,
    quotaCommand,
    Command.provide(ladderCommand, Registry.layerSql.pipe(Layer.provideMerge(Runs.layer))),
    Command.provide(modelsCommand, Registry.layer),
    Command.provide(reviewersCommand, Registry.layer),
    Command.provide(statsCommand, storeServices),
    Command.provide(queueCommand, storeServices),
    Command.provide(showCommand, storeServices),
    Command.provide(logCommand, storeServices),
    Command.provide(listCommand, storeServices),
    Command.provide(runsCommand, storeServices),
    policyCommand,
    scheduleCommand,
    linearCommand,
    Command.provide(pipelineCommand(services), Registry.layer),
    ...subcommands(services),
  ]),
);

const cli = foreman.pipe(Command.run({ version: VERSION }));

// A refusal is logged on stderr, so stdout holds only what a command prints:
// a caller that parses --json, and the Foreman pane that shows the refusal,
// each read their own stream. runMain logs a failure outside every reference
// provided to the program, so the program logs it here and runMain does not.
const reported = cli.pipe(
  Effect.provide(BunServices.layer),
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) || !Runtime.getErrorReported(Cause.squash(cause))
      ? Effect.void
      : Effect.logError(cause),
  ),
  Effect.provideService(Logger.LogToStderr, true),
);

BunRuntime.runMain(reported, { disableErrorReporting: true });
