import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect, FileSystem } from "effect";
import { Records } from "./records.ts";
import { report } from "./report.ts";
import { tablesFor } from "./runs.ts";

/** Reads the task store's run records, so it is safe without a running dispatcher. */
export const stats = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const records = yield* Records;
  const state = process.env["XDG_STATE_HOME"] ?? `${process.env["HOME"] ?? ""}/.local/state`;
  const output = `${state}/foreman/stats.html`;
  const runs = yield* records.closedSince(new Date(0));
  yield* fs.makeDirectory(`${state}/foreman`, { recursive: true });
  yield* fs.writeFileString(output, report(tablesFor(runs)));
  yield* spawner.spawn(ChildProcess.make("xdg-open", [`file://${output}`])).pipe(Effect.asVoid);
}).pipe(Effect.scoped);
