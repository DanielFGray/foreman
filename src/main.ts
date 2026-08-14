#!/usr/bin/env bun
import { Command, Options } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, type Option, Schema } from "effect";
import { settings } from "./config.ts";
import { dashboard } from "./dashboard.tsx";
import { Dispatcher } from "./dispatcher.ts";
import { HerdrFleet } from "./herdr.ts";
import { fileLogger } from "./log.ts";

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

const foreman = Command.make("foreman", { slots }, ({ slots }) =>
  Effect.gen(function* () {
    const dispatcher = yield* Dispatcher;
    // The loop is forked and the dashboard is parked on, so closing the
    // dashboard ends the process: an operator who quits the screen means to
    // stop the fleet, not to leave it dispatching where they cannot see it.
    yield* Effect.forkScoped(dispatcher.run);
    yield* dashboard;
  }).pipe(Effect.scoped, Effect.provide(live(slots))),
);

/**
 * herdr is the only multiplexer foreman speaks to today. Swapping this one line
 * for another adapter is the whole of that migration. Dispatcher.Default brings
 * its own dependencies — Prog and Prompts — and sits on top of the base set,
 * which feeds it the Settings and Fleet it cannot build itself.
 */
const live = (slots: Option.Option<number>) =>
  Layer.provideMerge(
    Dispatcher.Default,
    Layer.mergeAll(HerdrFleet, settings({ slots }), fileLogger()),
  );

const cli = Command.run(foreman, { name: "foreman", version: "0.1.0" });

BunRuntime.runMain(cli(process.argv).pipe(Effect.provide(BunContext.layer)));
