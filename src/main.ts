#!/usr/bin/env bun
import { Command, Options } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, Option, Schema } from "effect";
import { type Overrides, settings } from "./config.ts";
import { dashboard } from "./dashboard.ts";
import { Dispatcher } from "./dispatcher.ts";
import { HerdrFleet } from "./herdr.ts";
import { logging } from "./log.ts";
import { runPlan } from "./plan.ts";
import { Prog } from "./prog.ts";
import { Prompts } from "./prompt.ts";
import { BOUND_KEYS } from "./view.ts";
import { fzfScreen } from "./screen.ts";

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
 * Plan mode is the front half of the pipeline: it turns a rough plan into
 * tasks in the backlog, which the daemon then drains. It runs in its own
 * process because it is one synchronous run with its own agents — the daemon
 * needs no changes for it, and its plan epics are invisible to the queue.
 */
const planCommand = Command.make(
  "plan",
  {
    project: Options.text("project").pipe(
      Options.optional,
      Options.withDescription("Project to plan in (default: the sole configured project)"),
    ),
    file: Options.fileText("file").pipe(
      Options.optional,
      Options.withDescription("Read the rough plan from a markdown file"),
    ),
    title: Options.text("title").pipe(
      Options.optional,
      Options.withDescription("Title for the plan epic (default: the plan's first line)"),
    ),
    epic: Options.text("epic").pipe(
      Options.optional,
      Options.withDescription("Resume an interrupted plan epic (ep-...)"),
    ),
  },
  ({ project, file, title, epic }) =>
    runPlan({
      project,
      title,
      epic,
      plan: Option.map(file, ([, content]) => content),
    }).pipe(Effect.asVoid, Effect.provide(planLive)),
).pipe(
  Command.withDescription(
    "Turn a rough plan into tasks: a planner agent writes a specification into a plan epic, then a tasker agent files it as tasks in the backlog",
  ),
);

const foreman = Command.make("foreman", { slots, running }, ({ slots, running }) =>
  Effect.gen(function* () {
    // The loop is forked and the dashboard is parked on, so closing the
    // dashboard ends the process: an operator who quits the screen means to
    // stop the fleet, not to leave it dispatching where they cannot see it.
    yield* Effect.forkScoped(Dispatcher.run);
    yield* dashboard;
  }).pipe(Effect.scoped, Effect.provide(live({ slots, running }))),
).pipe(Command.withSubcommands([planCommand]));

/**
 * herdr is the only multiplexer foreman speaks to today. Swapping this one line
 * for another adapter is the whole of that migration. Dispatcher.Default brings
 * its own dependencies — Prog and Prompts — and sits on top of the base set,
 * which feeds it the Settings and Fleet it cannot build itself.
 */
const live = (overrides: Overrides) =>
  Layer.provideMerge(
    Dispatcher.Default,
    Layer.mergeAll(HerdrFleet, settings(overrides), logging(), fzfScreen(BOUND_KEYS)),
  );

/** Plan mode needs the same world as the daemon minus the dispatcher. */
const planLive = Layer.mergeAll(
  HerdrFleet,
  // Plan mode drives its own agents to completion and never dispatches, so
  // the pause the daemon starts under has nothing to hold back.
  settings({ slots: Option.none(), running: true }),
  Prog.Default,
  Prompts.Default,
  logging(),
);

const cli = Command.run(foreman, { name: "foreman", version: "0.1.0" });

BunRuntime.runMain(cli(process.argv).pipe(Effect.provide(BunContext.layer)));
