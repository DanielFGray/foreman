import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect, FileSystem } from "effect";
import { report } from "./report.ts";
import { runsFromOtlp, tablesFor } from "./runs.ts";

/** Reads collector-owned history, so it is safe without a running dispatcher. */
export const stats = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = process.env["XDG_STATE_HOME"] ?? `${process.env["HOME"] ?? ""}/.local/state`;
  const history = `${state}/otelcol/history`;
  const files = (yield* fs.readDirectory(history)).filter((file) =>
    /^traces\.json(?:\.\d+)?$/.test(file),
  );
  const payloads = yield* Effect.forEach(files, (file) =>
    fs.readFileString(`${history}/${file}`).pipe(Effect.orElseSucceed(() => "")),
  );
  const output = `${state}/foreman/stats.html`;
  yield* fs.makeDirectory(`${state}/foreman`, { recursive: true });
  yield* fs.writeFileString(output, report(tablesFor(runsFromOtlp(payloads))));
  yield* spawner.spawn(ChildProcess.make("xdg-open", [`file://${output}`])).pipe(Effect.asVoid);
}).pipe(Effect.scoped);
