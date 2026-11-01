#!/usr/bin/env bun
import { Command, Flag } from "effect/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer, Stream, SubscriptionRef } from "effect";
import { publishedOf, publishedPath, writePublished } from "./published.ts";
import { settings, Settings } from "./config.ts";
import { resetsLabel, quotaJson, usedLabel } from "./format.ts";
import { dispatchable, providerOf, providersOf, rungsOn } from "./ladder.ts";
import { Dispatcher } from "./dispatcher.ts";
import { HcFleet } from "./hc.ts";
import { logging } from "./log.ts";
import { Prog } from "./prog.ts";
import { Prompts } from "./prompt.ts";
import { exhausted, freeAt, Quota } from "./quota.ts";
import { Repository } from "./repository.ts";
import { telemetry, VERSION } from "./telemetry.ts";
import { ladderCommand } from "./ladder-command.ts";
import { Trials } from "./trials.ts";
import { stats } from "./stats.ts";
import { subcommands } from "./commands.ts";
import { policyCommand } from "./policy-command.ts";

/**
 * What every account behind the ladder has left, without starting anything.
 *
 * The dashboard shows the same reading, but only while a daemon is up and only
 * inside a terminal it owns. This is the question asked before that: whether
 * there is any point starting the fleet today, and which rungs are stopped.
 * One `Quota` behind both — the dashboard row and this are two callers, not two
 * readings.
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
      providersOf(config.ladder),
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
        // Unreadable is not spent. The daemon dispatches such a rung anyway,
        // so this must say the same thing rather than read as a wall.
        yield* Console.log(`${reading.provider}  unreadable: ${reading.detail}`);
      }
    }
  }).pipe(Effect.provide(Layer.mergeAll(Quota.Default, settings))),
).pipe(
  Command.withDescription(
    "Report how much of each provider's allowance the ladder has left, and which rungs are stopped",
  ),
);

const statsCommand = Command.make("stats", {}, () => stats).pipe(
  Command.withDescription("Render collected fleet metrics as a self-contained HTML report"),
);

/**
 * The queue as the next tick would dispatch it, without starting anything.
 *
 * The dashboard shows the same order, but only while a daemon is up and only
 * inside a terminal it owns. This is the question asked before that: what
 * would the fleet do next. It is the dispatcher's own reading of the queue,
 * so the two cannot disagree about what is next. It does not say which of them
 * the policy lets the fleet start by itself.
 */
const queueCommand = Command.make("queue", {}, () =>
  Effect.gen(function* () {
    const dispatcher = yield* Dispatcher;
    yield* dispatcher.read;
    const { queue } = yield* SubscriptionRef.get(dispatcher.state);
    if (queue.length === 0) return yield* Console.log("queue empty");
    for (const task of queue) {
      yield* Console.log(`${task.id} [${task.project}] p${task.priority} ${task.title}`);
    }
  }),
).pipe(
  Command.withDescription("Print the ready queue in the order the next tick would dispatch it"),
);

/**
 * Waits for SIGINT or SIGTERM, so a stopped daemon says so in its log instead
 * of leaving a gap that reads as a crash. Winning ends the program: the scope
 * closes and the loop is interrupted.
 */
const signals = Effect.callback<NodeJS.Signals>((resume) => {
  const handlers: ReadonlyArray<[NodeJS.Signals, NodeJS.SignalsListener]> = [
    ["SIGINT", () => resume(Effect.succeed("SIGINT"))],
    ["SIGTERM", () => resume(Effect.succeed("SIGTERM"))],
  ];
  handlers.forEach(([signal, handler]) => process.on(signal, handler));
  return Effect.forEach(
    handlers,
    ([signal, handler]) => Effect.sync(() => process.off(signal, handler)),
    { discard: true },
  );
}).pipe(
  Effect.tap((signal) => Effect.logWarning(`received ${signal}, stopping`)),
  Effect.asVoid,
);

/**
 * hc is the only multiplexer foreman speaks to today. Swapping this one line
 * for another adapter is the whole of that migration. The base set supplies
 * Dispatcher with every port it cannot build itself.
 *
 * `telemetry` reads the endpoint out of the same `Settings` the rest of the set
 * is given, so it is provided that layer rather than merged beside it; one
 * reference means the config is still built once. It sets the tracer for the
 * whole program, which is why it belongs here and not around a single call.
 * If DevTools is ever added it must come *before* the tracing layers, or the
 * tracer it patches is not the one foreman ends up using.
 */
const services = Layer.provideMerge(
  Dispatcher.Default,
  Layer.mergeAll(
    HcFleet,
    settings,
    Prog.Default,
    Prompts.Default,
    Quota.Default,
    Repository.Default,
    Trials.Default,
    BunServices.layer,
    logging(),
    telemetry.pipe(Layer.provide(settings)),
  ),
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

/** The loop, until a signal ends the process. */
const daemon = Effect.gen(function* () {
  const dispatcher = yield* Dispatcher;
  yield* Effect.forkScoped(dispatcher.run);
  // Every reading is published for the panel. A write that fails is logged and
  // the next reading tries again: the file is a view, and a stale one says so
  // through its timestamp. The state before the first read is not a reading:
  // published, it would tell a reader the fleet is empty, and the previous
  // daemon's file says more until a read lands.
  yield* Effect.forkScoped(
    Stream.runForEach(
      SubscriptionRef.changes(dispatcher.state).pipe(
        Stream.filter((state) => state.observedAt !== undefined),
      ),
      (state) =>
        writePublished(publishedPath(), publishedOf(state, true)).pipe(
          Effect.catchCause(Effect.logWarning),
        ),
    ),
  );
  yield* signals;
}).pipe(Effect.scoped, Effect.provide(services));

const foreman = Command.make("foreman", { skill }, ({ skill }) =>
  Effect.gen(function* () {
    if (skill) return yield* printSkill;
    return yield* daemon;
  }),
).pipe(
  Command.withSubcommands([
    quotaCommand,
    ladderCommand,
    statsCommand,
    Command.provide(queueCommand, services),
    policyCommand,
    ...subcommands(services),
  ]),
);

const cli = foreman.pipe(Command.run({ version: VERSION }));

BunRuntime.runMain(cli.pipe(Effect.provide(BunServices.layer)));
