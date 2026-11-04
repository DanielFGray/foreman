import { Command, Flag } from "effect/cli";
import { Console, Effect, Layer } from "effect";
import { store, Tasks } from "tasks";
import { homedir } from "node:os";
import { join } from "node:path";
import { cutoverExitIds, cutoverLines } from "./cutover-exits.ts";
import { convert, reportLines } from "./cutover-runs.ts";
import { Repository } from "./repository.ts";

/**
 * The one-time conversions of an upgrade. `foreman cutover runs` turns foreman's
 * old labels into runs, in the store `PROG_DB` names; `foreman cutover
 * exit-ids` gives each exit an id, in the files `FOREMAN_PIPELINES` names and
 * the drafts file beside it. A coordinator rehearses each on a copy first.
 */

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print what would be written, and write nothing"),
);

const root = Flag.String("root").pipe(
  Flag.withDefault(join(homedir(), "build")),
  Flag.withDescription("The folder that holds each project's checkout, one folder per project"),
);

const exitIds = Command.make("exit-ids", { dryRun }, ({ dryRun }) =>
  cutoverExitIds({ dryRun }).pipe(
    Effect.flatMap((reports) => Console.log(cutoverLines(reports, dryRun).join("\n"))),
  ),
).pipe(
  Command.withDescription(
    "Give each exit in the pipelines and drafts files an id, its name, and mark each author's already-done exit as its claim. Run it once after the upgrade, with the dispatcher stopped",
  ),
);

const runs = Command.make("runs", { dryRun, root }, (args) =>
  convert(args).pipe(Effect.flatMap((report) => Console.log(reportLines(report).join("\n")))),
).pipe(
  Command.withDescription(
    "Turn the by, review-by, review-failed-by, rounds, approved, satisfied, failed-by, attempt, walled and needs-you labels of unfinished tasks into runs, charges and parks, then remove the labels",
  ),
  Command.provide(
    Layer.mergeAll(Tasks.layerSql, Repository.Default).pipe(Layer.provideMerge(store)),
  ),
);

export const cutoverCommand = Command.make("cutover", {}).pipe(
  Command.withDescription("One-time conversions for a foreman upgrade"),
  Command.withSubcommands([runs, exitIds]),
);
