/**
 * Rewrites the backlog's foreman labels onto the `<kind>:<value>` scheme, once.
 *
 * The old scheme named the rung a task's next dispatch had to use. That is a
 * pointer into the configured ladder, so commenting a model out reclassified
 * every task holding it as work waiting on a person. What replaces it is
 * evidence — `failed-by:<rung>` for each rung that was tried and was not
 * enough — and the ladder chooses from that plus what is configured and paid
 * for at the moment of dispatch.
 *
 * So `rung-X` becomes a failure for every rung *below* X in the ladder, which
 * is what "this task earned rung X" meant all along. Every other foreman label
 * keeps its meaning and only changes separator.
 *
 * That reading holds only for a ladder unchanged since the task climbed. A rung
 * inserted below one a task had already reached was never tried by it, so this
 * writes a failure for a run that never happened, and the label then stops that
 * rung ever being tried on any older work. After running it, check each rung for
 * a `by:` or `attempt:` label somewhere in the backlog and take the failures
 * back off any rung that has neither.
 *
 * Run it with the daemon stopped: it rewrites the labels the daemon reads.
 *
 *   bun scripts/relabel.ts            # print what would change
 *   bun scripts/relabel.ts --apply    # do it
 */
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Schema } from "effect";
import { settings, Settings } from "../src/config.ts";
import { type Ladder, rankOf } from "../src/ladder.ts";
import { NEEDS_YOU } from "../src/prog.ts";

const Task = Schema.Struct({
  id: Schema.String,
  labels: Schema.Array(Schema.String),
});

/** The old label kinds, and what each becomes. */
const RENAMED: ReadonlyArray<readonly [string, string]> = [
  ["review-by-", "review-by:"],
  ["by-", "by:"],
  ["diagnosing-", "diagnosing:"],
];

const program = Effect.gen(function* () {
  const apply = process.argv.includes("--apply");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { ladder } = yield* Settings;

  const run = (...args: ReadonlyArray<string>) => spawner.string(ChildProcess.make("prog", args));

  const tasks = yield* run("list", "--json").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Task)))),
  );

  for (const task of tasks) {
    const changes = rewrite(task.labels, ladder);
    if (changes.add.length === 0 && changes.remove.length === 0) continue;

    yield* Effect.logInfo(
      [
        task.id,
        ...changes.remove.map((label) => `-${label}`),
        ...changes.add.map((label) => `+${label}`),
      ].join("  "),
    );
    if (!apply) continue;

    for (const label of changes.remove) yield* run("unlabel", task.id, label);
    for (const label of changes.add) yield* run("label", task.id, label);
  }

  if (!apply) yield* Effect.logInfo("nothing written — pass --apply to write it");
});

/**
 * What one task's labels become.
 *
 * `rung-human` is a person's decision to park the task, which the new scheme
 * states directly. Every other `rung-X` is a claim about models, and the
 * failures below X are what earned it: the rung itself was never tried, so it
 * records nothing.
 */
const rewrite = (
  labels: ReadonlyArray<string>,
  ladder: Ladder,
): { readonly add: ReadonlyArray<string>; readonly remove: ReadonlyArray<string> } => {
  const add: Array<string> = [];
  const remove: Array<string> = [];

  for (const label of labels) {
    if (label === "rung-human") {
      remove.push(label);
      add.push(NEEDS_YOU);
      continue;
    }

    if (label.startsWith("rung-")) {
      remove.push(label);
      const rank = rankOf(ladder, label.slice("rung-".length));
      // A rung the config never had positions nothing, so the task starts over
      // at the bottom rather than being pinned to a name nobody can read.
      for (const lower of ladder.slice(0, rank ?? 0)) add.push(`failed-by:${lower.name}`);
      continue;
    }

    const attempt = /^attempt-(.+)-([0-9]+)$/.exec(label);
    if (attempt) {
      remove.push(label);
      add.push(`attempt:${attempt[1]}:${attempt[2]}`);
      continue;
    }

    const renamed = RENAMED.find(([from]) => label.startsWith(from));
    if (renamed) {
      remove.push(label);
      add.push(`${renamed[1]}${label.slice(renamed[0].length)}`);
    }
  }

  return { add: [...new Set(add)].filter((label) => !labels.includes(label)), remove };
};

BunRuntime.runMain(
  program.pipe(
    Effect.provide(
      settings.pipe(
        Layer.provideMerge(BunServices.layer),
      ),
    ),
  ),
);
