#!/usr/bin/env bun
import { Command, Flag } from "effect/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { type Overrides, settings, Settings } from "./config.ts";
import { resetsLabel, quotaJson, usedLabel } from "./format.ts";
import { authorFor, dispatchable, providerOf, providersOf, rungsOn } from "./ladder.ts";
import { pinnedFirst, pinnedOf } from "./pin.ts";
import { failuresOf, isOnboarding, needsYou } from "./prog.ts";
import { dashboard } from "./dashboard.ts";
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
import { BOUND_KEYS } from "./view.ts";
import { fzfScreen } from "./screen.ts";
import { stats } from "./stats.ts";
import { subcommands } from "./commands.ts";

/**
 * How many tasks may be in flight at once.
 *
 * On the command line as well as in the config file because it is the one
 * setting an operator changes per run: one slot while watching a change land,
 * more once it is trusted. Everything else describes the fleet itself and
 * belongs only in the file.
 */
const slots = Flag.Int("slots").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("Concurrent workers, overriding the config file"),
  // Same constraint the config file carries. A fleet of zero is a stopped
  // daemon written the long way round, and a negative one is a typo.
  Flag.withSchema(Schema.Finite.check(Schema.isGreaterThan(0))),
  Flag.optional,
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
const running = Flag.Boolean("running").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Start dispatching immediately, rather than paused"),
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
            Effect.succeed({ _tag: "unreadable", provider, detail: error.detail } as const),
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
 * The queue as the next tick would dispatch it, without starting anything.
 *
 * The dashboard shows the same order, but only while a daemon is up and only
 * inside a terminal it owns. This is the question asked before that: what
 * would the fleet do next. One reading of `prog ready`, ordered by the same
 * rules the dispatcher uses — pinned first, then the ordinary score with its
 * project rotation — so the two never disagree about what is next.
 */
const queueCommand = Command.make("queue", {}, () =>
  Effect.gen(function* () {
    const config = yield* Settings;
    const prog = yield* Prog;

    const managed = new Set(config.projects.map((project) => project.name));
    const queue = yield* prog.ready();
    const pinned = yield* pinnedOf(yield* prog.pinned(), managed, (id) => prog.children(id));

    // How close each task's own epic is to done, for the ones whose epic is
    // not itself pinned — the same map the dispatcher builds, because a pinned
    // epic's children already lead absolutely.
    const epicCompletion = new Map<string, number>();
    for (const project of config.projects) {
      for (const epic of yield* prog.inProgressEpics(project.name)) {
        if (epic.labels.includes("pin")) continue;
        const children = yield* prog.children(epic.id);
        if (children.length === 0) continue;
        const fraction =
          children.filter((child) => child.status === "done").length / children.length;
        for (const child of children) epicCompletion.set(child.id, fraction);
      }
    }
    const epicFractionOf = (task: { readonly id: string }) => epicCompletion.get(task.id) ?? 0;

    // Work waiting on the operator is ready by every measure prog knows and
    // still must not be dispatched, so it is not queue. Salvage runs stand in
    // a directory a person is using and start only when asked, never from here.
    const parked = (task: { readonly labels: ReadonlyArray<string> }) =>
      needsYou(task) || authorFor(config.ladder, failuresOf(task))._tag === "Yours";
    const dispatchable = queue.filter((task) => !isOnboarding(task) && !parked(task));
    const ordered = pinnedFirst(dispatchable, pinned, [...managed], epicFractionOf);

    if (ordered.length === 0) {
      yield* Console.log("queue empty");
      return;
    }
    for (const task of ordered) {
      yield* Console.log(
        `${task.id} [${task.project}] p${task.priority}${pinned.has(task.id) ? " 📌" : ""} ${task.title}`,
      );
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Prog.Default, settings({ slots: Option.none(), running: false })),
    ),
  ),
).pipe(
  Command.withDescription("Print the ready queue in the order the next tick would dispatch it"),
);

/**
 * Waits for SIGINT or SIGTERM, so a stopped daemon says so in its log instead
 * of leaving a gap that reads as a crash. Winning this race ends the program
 * the way an operator closing the screen does: the scope closes, the screen is
 * torn down and the loop is interrupted.
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
const services = (overrides: Overrides) => {
  const config = settings(overrides);
  return Layer.provideMerge(
    Dispatcher.Default,
    Layer.mergeAll(
      HcFleet,
      config,
      Prog.Default,
      Prompts.Default,
      Quota.Default,
      Repository.Default,
      Trials.Default,
      logging(),
      telemetry.pipe(Layer.provide(config)),
    ),
  );
};

/** The daemon's set: every service, and the screen the dashboard draws on. */
const live = (overrides: Overrides) => Layer.merge(services(overrides), fzfScreen(BOUND_KEYS));

/**
 * How to drive foreman by hand, for an agent coordinating a fleet. Printed
 * rather than installed as a skill file, so it ships with the binary it
 * describes and cannot fall behind it.
 */
const skill = Flag.Boolean("skill").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print how to drive foreman's lifecycle by hand, then exit"),
);

const foreman = Command.make("foreman", { slots, running, skill }, ({ slots, running, skill }) =>
  skill
    ? FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(`${import.meta.dir}/skill.md`)),
        Effect.flatMap(Console.log),
      )
    : Effect.gen(function* () {
        // The loop is forked and the dashboard is parked on, so closing the
        // dashboard ends the process: an operator who quits the screen means to
        // stop the fleet, not to leave it dispatching where they cannot see it.
        // A signal ends it through the same race.
        yield* Effect.forkScoped((yield* Dispatcher).run);
        yield* Effect.raceFirst(dashboard, signals);
      }).pipe(Effect.scoped, Effect.provide(live({ slots, running }))),
).pipe(
  Command.withSubcommands([
    quotaCommand,
    ladderCommand,
    statsCommand,
    queueCommand,
    ...subcommands(services({ slots: Option.none(), running: false })),
  ]),
);

const cli = foreman.pipe(Command.run({ version: VERSION }));

BunRuntime.runMain(cli.pipe(Effect.provide(BunServices.layer)));
