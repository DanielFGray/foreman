#!/usr/bin/env bun
import { Command, Options } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Layer, Option, Schema } from "effect";
import { type Overrides, settings, Settings } from "./config.ts";
import { providerOf, providersOf, rungsOn } from "./ladder.ts";
import { dashboard } from "./dashboard.ts";
import { Dispatcher } from "./dispatcher.ts";
import { HerdrFleet } from "./herdr.ts";
import { logging } from "./log.ts";
import { Prog } from "./prog.ts";
import { Prompts } from "./prompt.ts";
import { exhausted, freeAt, Quota } from "./quota.ts";
import { Repository } from "./repository.ts";
import { telemetry, VERSION } from "./telemetry.ts";
import { BOUND_KEYS } from "./view.ts";
import { fzfScreen } from "./screen.ts";
import { stats } from "./stats.ts";

/**
 * How many tasks may be in flight at once.
 *
 * On the command line as well as in the config file because it is the one
 * setting an operator changes per run: one slot while watching a change land,
 * more once it is trusted. Everything else describes the fleet itself and
 * belongs only in the file.
 */
const slots = Options.integer("slots").pipe(
  Options.withAlias("n"),
  Options.withDescription("Concurrent workers, overriding the config file"),
  // Same constraint the config file carries. A fleet of zero is a stopped
  // daemon written the long way round, and a negative one is a typo.
  Options.withSchema(Schema.Positive),
  Options.optional,
);

/**
 * Whether this run starts dispatching, rather than paused.
 *
 * Foreman pauses on start so an operator can drain a fleet without racing the
 * first tick. A restart is not that operator: `bun --watch` restarts the daemon
 * whenever foreman's own source changes — landing a task into foreman's own
 * checkout does exactly that — and the fleet parked itself after every landing.
 * The command line is the only thing a restart inherits, so it is where the
 * answer belongs.
 */
const running = Options.boolean("running").pipe(
  Options.withDescription("Start dispatching immediately, rather than paused"),
);

/**
 * What every account behind the ladder has left, without starting anything.
 *
 * The dashboard shows the same reading, but only while a daemon is up and only
 * inside a terminal it owns. This is the question asked before that: whether
 * there is any point starting the fleet today, and which rungs are stopped.
 * One `Quota` behind both — the dashboard row and this are two callers, not two
 * readings.
 */
const quotaCommand = Command.make("quota", {}, () =>
  Effect.gen(function* () {
    const config = yield* Settings;
    const quota = yield* Quota;

    const blind = config.ladder.filter((rung) => providerOf(rung) === undefined);
    if (blind.length > 0) {
      yield* Console.log(
        `no provider derivable for ${blind.map((rung) => rung.name).join(", ")} — add "provider" to each rung to have its quota read`,
      );
    }

    yield* Effect.forEach(
      providersOf(config.ladder),
      (provider) =>
        quota.usage(provider).pipe(
          Effect.flatMap((usage) =>
            Console.log(
              [
                `${usage.provider}${usage.plan === undefined ? "" : ` [${usage.plan}]`}  rungs ${rungsOn(config.ladder, provider).join(", ")}  ${exhausted(usage) ? `OUT OF QUOTA until ${freeAt(usage)?.toLocaleString() ?? "unknown"}` : "ok"}`,
                ...usage.allowances.map(
                  (allowance) =>
                    `    ${allowance.window.padEnd(18)} ${String(allowance.usedPercent).padStart(3)}% used   resets ${allowance.resetsAt?.toLocaleString() ?? "unknown"}`,
                ),
              ].join("\n"),
            ),
          ),
          // Unreadable is not spent. The daemon dispatches such a rung anyway,
          // so this must say the same thing rather than read as a wall.
          Effect.catchTag("QuotaError", (error) =>
            Console.log(`${provider}  unreadable: ${error.detail}`),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Quota.Default, settings({ slots: Option.none(), running: false })),
    ),
  ),
).pipe(
  Command.withDescription(
    "Report how much of each provider's allowance the ladder has left, and which rungs are stopped",
  ),
);

const statsCommand = Command.make("stats", {}, () => stats).pipe(
  Command.withDescription("Render collected fleet metrics as a self-contained HTML report"),
);

/**
 * Waits for SIGINT or SIGTERM, so a stopped daemon says so in its log instead
 * of leaving a gap that reads as a crash. Winning this race ends the program
 * the way an operator closing the screen does: the scope closes, the screen is
 * torn down and the loop is interrupted.
 */
const signals = Effect.async<NodeJS.Signals>((resume) => {
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

const foreman = Command.make("foreman", { slots, running }, ({ slots, running }) =>
  Effect.gen(function* () {
    // The loop is forked and the dashboard is parked on, so closing the
    // dashboard ends the process: an operator who quits the screen means to
    // stop the fleet, not to leave it dispatching where they cannot see it.
    // A signal ends it through the same race.
    yield* Effect.forkScoped(Dispatcher.run);
    yield* Effect.raceFirst(dashboard, signals);
  }).pipe(Effect.scoped, Effect.provide(live({ slots, running }))),
).pipe(Command.withSubcommands([quotaCommand, statsCommand]));

/**
 * herdr is the only multiplexer foreman speaks to today. Swapping this one line
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
const live = (overrides: Overrides) => {
  const config = settings(overrides);
  return Layer.provideMerge(
    Dispatcher.Default,
    Layer.mergeAll(
      HerdrFleet,
      config,
      Prog.Default,
      Prompts.Default,
      Quota.Default,
      Repository.Default,
      logging(),
      fzfScreen(BOUND_KEYS),
      telemetry.pipe(Layer.provide(config)),
    ),
  );
};

const cli = Command.run(foreman, { name: "foreman", version: VERSION });

BunRuntime.runMain(cli(process.argv).pipe(Effect.provide(BunContext.layer)));
