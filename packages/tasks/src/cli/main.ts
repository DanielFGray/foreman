#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { Runs } from "tasks";
import { tasksCommand } from "./commands.ts";
import { refusals } from "./errors.ts";

/** The `tasks` program. A missing store file is created and migrated on open. */
const program = tasksCommand.pipe(Command.provide(Runs.layer), Command.run({ version: "0.1.0" }));

BunRuntime.runMain(program.pipe(Effect.catchTags(refusals), Effect.provide(BunServices.layer)));
