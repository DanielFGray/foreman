import { Command, Flag } from "effect/cli";
import { Console, Effect, Layer } from "effect";
import { store, Tasks } from "tasks";
import { homedir } from "node:os";
import { join } from "node:path";
import { convert, reportLines } from "./cutover-runs.ts";
import { Repository } from "./repository.ts";

/**
 * `foreman cutover runs`: the one-time conversion of foreman's old labels into
 * runs. It acts on the store `PROG_DB` names, so a coordinator rehearses it on
 * a copy first.
 */

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print what would be written, and write nothing"),
);

const root = Flag.String("root").pipe(
  Flag.withDefault(join(homedir(), "build")),
  Flag.withDescription("The folder that holds each project's checkout, one folder per project"),
);

const runs = Command.make("runs", { dryRun, root }, (args) =>
  convert(args).pipe(Effect.flatMap((report) => Console.log(reportLines(report).join("\n")))),
).pipe(
  Command.withDescription(
    "Turn the by, review-by, review-failed-by, rounds, approved and satisfied labels of unfinished tasks into runs, then remove the labels",
  ),
  Command.provide(
    Layer.mergeAll(Tasks.layerSql, Repository.Default).pipe(Layer.provideMerge(store)),
  ),
);

export const cutoverCommand = Command.make("cutover", {}).pipe(
  Command.withDescription("One-time conversions for a foreman upgrade"),
  Command.withSubcommands([runs]),
);
