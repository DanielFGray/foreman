import { Argument, CliError, Command, Flag } from "effect/cli";
import { Console, Effect, Layer, Option, Schema } from "effect";
import { launchArguments } from "./harness.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogLayer } from "./model-advice-catalog.ts";
import { NonNegativeTokenCount, runSuggest } from "./model-advice-run.ts";
import { Quota } from "./quota.ts";
import {
  addRow,
  changeRow,
  moveRow,
  type LadderRow,
  knownModels,
  parseRows,
  readModels,
  readReviewers,
  readRows,
  readStatus,
  sizeSummary,
  type RungStatus,
  renderRows,
  RegistryError,
  type RungPlace,
  writeRows,
} from "./registry.ts";
import { reviewerJson } from "./reviewers-command.ts";

/**
 * `foreman ladder`: read and edit the registry's ladder.
 *
 * The ladder lives in a database, and a database is awkward to edit by hand.
 * `edit` hands it to your editor as a short list of objects, one per rung, and
 * applies what you save in one validated transaction, so reordering is moving a
 * block and a typo changes nothing. These commands touch only the ladder; the
 * models behind it are rows in the herd skill's registry schema.
 */

const json = Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Emit JSON"));

const list = Command.make("list", { json }, ({ json }) =>
  Effect.gen(function* () {
    const rows = yield* readStatus;
    if (json) return yield* Console.log(JSON.stringify(rows, null, 2));
    for (const row of rows) {
      const record =
        row.slices === 0
          ? "no trials"
          : `${row.succeeded}/${row.slices} landed, ${row.avgRounds ?? "?"} rounds avg`;
      const roles = `author ${row.author ? "on" : "off"}`;
      yield* Console.log(
        `${String(row.level).padStart(2)}  ${row.rung.padEnd(26)} ${row.state.padEnd(8)} ${roles}  ${row.model}  ${record}  ${launchHint(row)}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "Print the ladder by level: state, roles, trial record and launch arguments",
  ),
);

/** Cost per landed slice by model and size: read it before starting a size a level up. */
const size = Command.make("size", {}, () =>
  Effect.gen(function* () {
    const rows = yield* sizeSummary;
    if (rows.length === 0) return yield* Console.log("no trials carry a size yet");
    for (const row of rows) yield* Console.log(JSON.stringify(row));
  }),
).pipe(Command.withDescription("Landed slices, rounds and cost per success, by model and size"));

/**
 * Where the registry and the world disagree: a rung opencode no longer lists, and
 * a free opencode model no registry row names.
 *
 * An empty listing is a failed probe, not proof that every rung is gone, so it
 * stops the check instead of reporting every rung as drifted.
 */
const drift = Command.make("drift", {}, () =>
  Effect.gen(function* () {
    const probe = yield* Effect.promise(async () => {
      const process = Bun.spawn(["opencode", "models"], { stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      return { code: await process.exited, out, err };
    });
    const listed = new Set(
      probe.out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
    if (probe.code !== 0 || listed.size === 0) {
      return yield* new RegistryError({
        detail: `\`opencode models\` listed nothing (exit ${probe.code}); run it again. ${probe.err.trim()}`,
      });
    }
    const known = yield* knownModels;
    const findings = [
      ...(yield* readStatus)
        .filter(
          (row) => row.harness === "opencode" && row.state !== "disabled" && !listed.has(row.model),
        )
        .map((row) => `drift: rung ${row.rung} names ${row.model}, which opencode no longer lists`),
      ...[...listed]
        .filter((model) => /\bfree\b/.test(model) && !known.has(model))
        .map((model) => `candidate: ${model} is free in opencode and in no registry row`),
    ];
    yield* Console.log(findings.length ? findings.join("\n") : "no drift");
  }),
).pipe(
  Command.withDescription("Rungs opencode no longer lists, and free models no registry row names"),
);

const edit = Command.make("edit", {}, () =>
  Effect.gen(function* () {
    const before = yield* readRows;
    const dir = mkdtempSync(join(tmpdir(), "foreman-ladder-"));
    const file = join(dir, "ladder.jsonc");
    try {
      writeFileSync(file, renderRows(before));
      const editor = process.env["VISUAL"] ?? process.env["EDITOR"] ?? "vi";
      const exit = yield* Effect.promise(
        () =>
          Bun.spawn(["sh", "-c", `${editor} "$1"`, "sh", file], {
            stdio: ["inherit", "inherit", "inherit"],
          }).exited,
      );
      if (exit !== 0) {
        return yield* new RegistryError({ detail: `${editor} exited ${exit}; ladder unchanged` });
      }
      const after = yield* Effect.try({
        try: () => parseRows(readFileSync(file, "utf8")),
        catch: (cause) => new RegistryError({ detail: `could not read your edit: ${cause}` }),
      });
      yield* writeRows(after);
      // The stored order, not the text's: a write sorts the rows by level.
      yield* Console.log(describeChange(before, yield* readRows));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }),
).pipe(Command.withDescription("Edit the ladder in $EDITOR; reorder, enable, add or drop rungs"));

const rung = Argument.String("rung").pipe(Argument.withDescription("A rung name"));

const model = Argument.String("model").pipe(
  Argument.withDescription("The rung's model; it must have a row in the models table"),
);
const above = Flag.String("above").pipe(
  Flag.withDescription("Put the rung just above this one"),
  Flag.optional,
);
const below = Flag.String("below").pipe(
  Flag.withDescription("Put the rung just below this one"),
  Flag.optional,
);
const disabled = Flag.Boolean("disabled").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Add it disabled"),
);
const note = Flag.String("note").pipe(Flag.withDescription("A note on the rung"), Flag.optional);

const add = Command.make("add", { rung, model, above, below, disabled, note }, (args) =>
  Effect.gen(function* () {
    const place = yield* placeOf(args);
    yield* addRow(
      {
        rung: args.rung,
        model: args.model,
        enabled: !args.disabled,
        author: true,
        provider: null,
        unmetered: false,
        note: Option.getOrNull(args.note),
      },
      place,
    );
    yield* Console.log(`${args.rung}: added ${whereOf(place)}`);
  }),
).pipe(
  Command.withDescription(
    "Add a rung in a level of its own: just --above or --below a rung's level, or at the bottom (the cheapest place)",
  ),
);

const move = Command.make("move", { rung, above, below }, (args) =>
  Effect.gen(function* () {
    const place = yield* placeOf(args);
    yield* moveRow(args.rung, place);
    yield* Console.log(`${args.rung}: moved ${whereOf(place)}`);
  }),
).pipe(
  Command.withDescription(
    "Move a rung to a level of its own: just --above or --below a rung's level, or to the bottom (the cheapest place)",
  ),
);

const levelNumber = Argument.Int("level").pipe(
  Argument.withDescription(
    "The level: levels climb in number, and the rungs of one level are peers",
  ),
);

/**
 * Put a rung in a level. Rungs that share a level share the author work, and
 * one failure on any of them sends a task up a level.
 */
const level = Command.make("level", { rung, level: levelNumber }, (args) =>
  Effect.gen(function* () {
    yield* changeRow(args.rung, (row) => ({ ...row, level: args.level }));
    yield* Console.log(`${args.rung}: level ${args.level}`);
  }),
).pipe(
  Command.withDescription("Put a rung in a level; the rungs of one level share the author work"),
);

/** The place the --above and --below flags name; neither is the bottom. */
const placeOf = (args: {
  readonly above: Option.Option<string>;
  readonly below: Option.Option<string>;
}): Effect.Effect<RungPlace, RegistryError> =>
  Option.isSome(args.above) && Option.isSome(args.below)
    ? Effect.fail(new RegistryError({ detail: "give --above or --below, not both" }))
    : Effect.succeed(
        Option.isSome(args.above)
          ? { _tag: "Above", rung: args.above.value }
          : Option.isSome(args.below)
            ? { _tag: "Below", rung: args.below.value }
            : { _tag: "Bottom" },
      );

const whereOf = (place: RungPlace) =>
  place._tag === "Bottom" ? "to the bottom" : `${place._tag.toLowerCase()} ${place.rung}`;

const toggle = (name: "enable" | "disable") =>
  Command.make(name, { rung }, (args) =>
    Effect.gen(function* () {
      yield* changeRow(args.rung, (row) => ({ ...row, enabled: name === "enable" }));
      yield* Console.log(`${args.rung}: ${name}d`);
    }),
  ).pipe(
    Command.withDescription(
      name === "enable"
        ? "Let foreman dispatch a rung again"
        : "Stop dispatching a rung; it keeps its place so old failures still position",
    ),
  );

const switch_ = Argument.String("switch").pipe(Argument.withDescription("on or off"));

/**
 * Turn a rung's author role on or off without retiring it: it keeps its level
 * and rank, so the failures naming it still position the work above it.
 */
const author = Command.make("author", { rung, switch: switch_ }, (args) =>
  Effect.gen(function* () {
    if (args.switch !== "on" && args.switch !== "off") {
      return yield* new RegistryError({
        detail: `switch is on or off, not ${args.switch}`,
      });
    }
    const on = args.switch === "on";
    yield* changeRow(args.rung, (row) => ({ ...row, author: on }));
    yield* Console.log(`${args.rung}: author ${args.switch}`);
  }),
).pipe(
  Command.withDescription("Turn a rung's author role on or off; it keeps its place either way"),
);

const catalog = Flag.String("catalog").pipe(
  Flag.withDescription("Local models.dev api.json path (offline / tests)"),
  Flag.optional,
);
const after = Flag.String("after").pipe(
  Flag.withDescription(
    "Only suggest rungs at a level above this rung's (escalation floor), as if it had failed the task",
  ),
  Flag.optional,
);
const optionalNonNeg = (name: string, description: string) =>
  Flag.Int(name).pipe(
    Flag.withSchema(NonNegativeTokenCount),
    Flag.withDescription(description),
    Flag.optional,
  );
const contextTokens = optionalNonNeg(
  "context-tokens",
  "Request context size for models.dev context price tiers",
);
const inputTokens = optionalNonNeg("input-tokens", "Uncached input tokens for the cost estimate");
const cacheReadTokens = optionalNonNeg(
  "cache-read-tokens",
  "Cache-read tokens for the cost estimate",
);
const cacheWriteTokens = optionalNonNeg(
  "cache-write-tokens",
  "Cache-write tokens for the cost estimate",
);
const outputTokens = optionalNonNeg("output-tokens", "Output tokens for the cost estimate");
const sizeFilter = Flag.Int("size").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  Flag.withDescription("Median token budget from trials with this size only"),
  Flag.optional,
);

/**
 * Read-only advice: the rung dispatch would pick (`authorFor`), with models.dev
 * list prices and current subscription windows beside each rung. Does not
 * dispatch or rewrite the ladder.
 */
const suggest = Command.make(
  "suggest",
  {
    json,
    catalog,
    after,
    contextTokens,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    size: sizeFilter,
  },
  (args) =>
    runSuggest({
      json: args.json,
      catalogPath: args.catalog,
      after: args.after,
      contextTokens: args.contextTokens,
      inputTokens: args.inputTokens,
      cacheReadTokens: args.cacheReadTokens,
      cacheWriteTokens: args.cacheWriteTokens,
      outputTokens: args.outputTokens,
      size: args.size,
    }).pipe(
      Effect.tap((text) => Console.log(text)),
      Effect.asVoid,
      Effect.provide(Layer.mergeAll(Quota.Default, catalogLayer)),
    ),
).pipe(
  Command.withDescription(
    "Show the rung dispatch would pick next, with catalog list prices and current quotas (advisory only)",
  ),
);

/**
 * `foreman ladder --json`: every rung in (level, rank) order with its level,
 * every model, and the reviewers as `foreman reviewers --json` prints them, so
 * a front end draws the worker list and the reviewer list from one read.
 */
export const ladderCommand = Command.make("ladder", { json }, ({ json }) =>
  Effect.gen(function* () {
    if (!json) return yield* new CliError.ShowHelp({ commandPath: ["ladder"], errors: [] });
    const document = {
      rungs: yield* readStatus,
      models: yield* readModels,
      reviewers: (yield* readReviewers).map(reviewerJson),
    };
    yield* Console.log(JSON.stringify(document, null, 2));
  }),
).pipe(
  Command.withDescription("Read and edit the model ladder in the registry"),
  Command.withSubcommands([
    list,
    size,
    drift,
    suggest,
    edit,
    add,
    toggle("enable"),
    toggle("disable"),
    author,
    move,
    level,
  ]),
);

/** One line per kind of change, so an edit's effect is read back before it is trusted. */
const describeChange = (
  before: ReadonlyArray<LadderRow>,
  after: ReadonlyArray<LadderRow>,
): string => {
  const names = (rows: ReadonlyArray<LadderRow>) => rows.map((row) => row.rung);
  const added = names(after).filter((name) => !names(before).includes(name));
  const dropped = names(before).filter((name) => !names(after).includes(name));
  const toggled = after.filter(
    (row) =>
      before.find((old) => old.rung === row.rung)?.enabled !== row.enabled &&
      !added.includes(row.rung),
  );
  const regrouped = after.flatMap((row) => {
    const old = before.find((other) => other.rung === row.rung)?.level;
    return old === undefined || old === row.level ? [] : [{ row, old }];
  });
  const kept = (rows: ReadonlyArray<LadderRow>, other: ReadonlyArray<LadderRow>) =>
    names(rows).filter((name) => names(other).includes(name));
  const moved = kept(before, after).join() !== kept(after, before).join();
  const lines = [
    ...(added.length ? [`added: ${added.join(", ")}`] : []),
    ...(dropped.length ? [`dropped: ${dropped.join(", ")}`] : []),
    ...toggled.map((row) => `${row.rung}: ${row.enabled ? "enabled" : "disabled"}`),
    ...regrouped.map(({ row, old }) => `${row.rung}: level ${old} → ${row.level}`),
    ...(moved ? ["reordered"] : []),
  ];
  return lines.length ? lines.join("\n") : "ladder unchanged";
};

/**
 * The flags a coordinator starts a rung's harness with. opencode
 * starts through its TUI, so its hint is the picker search rather than a flag.
 */
const launchHint = (row: RungStatus): string => {
  if (row.harness === "cursor") return "auto picks model and effort";
  if (row.harness === "opencode") {
    const search = (row.model.split("/").pop() ?? row.model)
      .replace(/:free$/, "")
      .replaceAll("-", " ");
    return `TUI picker search "${search}"`;
  }
  return launchArguments({ kind: row.harness, model: row.model, thinking: row.thinking }).join(" ");
};
