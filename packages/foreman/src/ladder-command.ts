import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Layer, Schema } from "effect";
import { launchArguments } from "./harness.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogLayer } from "./model-advice-catalog.ts";
import { NonNegativeTokenCount, runSuggest } from "./model-advice-run.ts";
import { Quota } from "./quota.ts";
import {
  type LadderRow,
  knownModels,
  parseRows,
  readRows,
  readStatus,
  sizeSummary,
  type RungStatus,
  renderRows,
  RegistryError,
  writeRows,
} from "./registry.ts";

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
    for (const [index, row] of rows.entries()) {
      const record =
        row.slices === 0
          ? "no trials"
          : `${row.succeeded}/${row.slices} landed, ${row.avgRounds ?? "?"} rounds avg`;
      yield* Console.log(
        `${String(index + 1).padStart(2)}  ${row.rung.padEnd(26)} ${row.state.padEnd(8)} ${row.model}  ${record}  ${launchHint(row)}`,
      );
    }
  }),
).pipe(Command.withDescription("Print the ladder: state, trial record and launch arguments"));

/** Cost per landed slice by model and size: read it before starting a size a tier up. */
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
      yield* Console.log(describeChange(before, after));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }),
).pipe(Command.withDescription("Edit the ladder in $EDITOR; reorder, enable, add or drop rungs"));

const rung = Argument.String("rung").pipe(Argument.withDescription("A rung name"));

const toggle = (name: "enable" | "disable") =>
  Command.make(name, { rung }, (args) =>
    Effect.gen(function* () {
      const rows = yield* readRows;
      if (!rows.some((row) => row.rung === args.rung)) {
        return yield* new RegistryError({
          detail: `no rung ${args.rung}; rungs: ${rows.map((row) => row.rung).join(", ")}`,
        });
      }
      yield* writeRows(
        rows.map((row) => (row.rung === args.rung ? { ...row, enabled: name === "enable" } : row)),
      );
      yield* Console.log(`${args.rung}: ${name}d`);
    }),
  ).pipe(
    Command.withDescription(
      name === "enable"
        ? "Let foreman dispatch a rung again"
        : "Stop dispatching a rung; it keeps its rank so old failures still position",
    ),
  );

const catalog = Flag.String("catalog").pipe(
  Flag.withDescription("Local models.dev api.json path (offline / tests)"),
  Flag.optional,
);
const after = Flag.String("after").pipe(
  Flag.withDescription("Only suggest rungs above this one (escalation floor)"),
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
 * Read-only advice: which enabled rung looks cheapest given models.dev list
 * prices and current subscription windows. Does not dispatch or rewrite the
 * ladder — `authorFor` stays authoritative.
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
    "Recommend an economical worker from catalog list prices and current quotas (advisory only)",
  ),
);

export const ladderCommand = Command.make("ladder", {}).pipe(
  Command.withDescription("Read and edit the model ladder in the registry"),
  Command.withSubcommands([list, size, drift, suggest, edit, toggle("enable"), toggle("disable")]),
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
  const kept = (rows: ReadonlyArray<LadderRow>, other: ReadonlyArray<LadderRow>) =>
    names(rows).filter((name) => names(other).includes(name));
  const moved = kept(before, after).join() !== kept(after, before).join();
  const lines = [
    ...(added.length ? [`added: ${added.join(", ")}`] : []),
    ...(dropped.length ? [`dropped: ${dropped.join(", ")}`] : []),
    ...toggled.map((row) => `${row.rung}: ${row.enabled ? "enabled" : "disabled"}`),
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
