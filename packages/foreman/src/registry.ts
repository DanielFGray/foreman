import { Array as Arr, Context, Effect, Layer, Option, Order, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { store } from "tasks";
import type { Ladder, Rung } from "./ladder.ts";
import type { Reviewer } from "./reviewers.ts";

/**
 * The model registry: the ladder, and the facts about each model on it.
 *
 * It is the `ladder` and `models` tables of the task store (`TASKS_DB`, else
 * `~/.tasks/tasks.db`), reached through the `SqlClient` the process shares with
 * the task layer, so the order of the models, their launch settings and the
 * record of how each one fared live in one file. Foreman reads the ladder from
 * it on every start and refuses to run without it: a second copy of the order
 * in a config file is a copy that can disagree.
 *
 * Models themselves (harness, pool) are rows the task store's migrations
 * define and the operator seeds. This module edits the ladder, which is the
 * part an operator reorders, enables and disables, and the reviewers, the list
 * a review block takes its reader from: a model may be a rung, a reviewer, both
 * or neither, and each rung and reviewer states its own thinking level.
 *
 * `Registry` is the service. The free effects below it (`readLadder`,
 * `writeRows`, ...) are `Registry.use` over its members, for callers that
 * want one read without naming the service.
 */

export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/**
 * One ladder row as an operator edits it. The list is sorted by (level, rank),
 * and a write takes the rank from the position in the list.
 */
export interface LadderRow {
  readonly rung: string;
  readonly level: number;
  readonly model: string;
  readonly enabled: boolean;
  readonly author: boolean;
  readonly provider: string | null;
  readonly unmetered: boolean;
  readonly note: string | null;
  /** The rung's thinking level; null passes no flag, so the harness's default applies. */
  readonly thinking: string | null;
}

/** One rung with the record the registry holds for its model. */
export interface RungStatus {
  readonly rung: string;
  readonly level: number;
  readonly harness: string;
  readonly model: string;
  readonly thinking: string | null;
  readonly enabled: boolean;
  /** `retired`, `disabled`, or the model's derived `proven` / `trial`. */
  readonly state: string;
  readonly author: boolean;
  readonly slices: number;
  readonly succeeded: number;
  readonly avgRounds: number | null;
}

/** One model with its harness, for a pane that draws the lists. */
export interface ModelEntry {
  readonly model: string;
  readonly harness: string;
  readonly retired: boolean;
}

/** A reviewer as `foreman reviewers add` states it. */
export interface NewReviewer {
  readonly name: string;
  readonly model: string;
  /** No flag, so the harness's own default, when absent. */
  readonly thinking: Option.Option<string>;
  /** Derived from the model when absent (`providerOf`). */
  readonly provider: Option.Option<string>;
}

/**
 * Where a rung goes: in a level of its own just above or below a named rung's
 * level, or below the lowest level, which is the cheapest place; or into a
 * numbered level, beside the rungs already there. Adding one by appending a
 * row would put it above every paid rung.
 */
export type RungPlace =
  | { readonly _tag: "Bottom" }
  | { readonly _tag: "Above"; readonly rung: string }
  | { readonly _tag: "Below"; readonly rung: string }
  | { readonly _tag: "Level"; readonly level: number };

/** SQLite keeps a flag as 0 or 1; a row that holds anything else is a defect. */
const EditableRow = Schema.Struct({
  rung: Schema.String,
  level: Schema.Int,
  model: Schema.String,
  enabled: Schema.BooleanFromBit,
  author: Schema.BooleanFromBit,
  provider: Schema.OptionFromNullOr(Schema.String),
  unmetered: Schema.BooleanFromBit,
  note: Schema.OptionFromNullOr(Schema.String),
  thinking: Schema.OptionFromNullOr(Schema.String),
});

const RungRow = Schema.Struct({
  rung: Schema.String,
  level: Schema.Int,
  model: Schema.String,
  enabled: Schema.BooleanFromBit,
  author: Schema.BooleanFromBit,
  provider: Schema.OptionFromNullOr(Schema.String),
  unmetered: Schema.BooleanFromBit,
  harness: Schema.String,
  thinking: Schema.OptionFromNullOr(Schema.String),
});

const StatusRow = Schema.Struct({
  rung: Schema.String,
  level: Schema.Int,
  harness: Schema.String,
  model: Schema.String,
  thinking: Schema.OptionFromNullOr(Schema.String),
  enabled: Schema.BooleanFromBit,
  author: Schema.BooleanFromBit,
  retired: Schema.BooleanFromBit,
  status: Schema.String,
  slices: Schema.Finite,
  succeeded: Schema.Finite,
  avg_rounds: Schema.OptionFromNullOr(Schema.Finite),
});

const ModelRow = Schema.Struct({
  model: Schema.String,
  harness: Schema.String,
  retired: Schema.BooleanFromBit,
});

const ModelIdRow = Schema.Struct({ model: Schema.String });

const ReviewerRow = Schema.Struct({
  reviewer: Schema.String,
  model: Schema.String,
  thinking: Schema.OptionFromNullOr(Schema.String),
  provider: Schema.OptionFromNullOr(Schema.String),
  harness: Schema.String,
});

const ReviewerNameRow = Schema.Struct({ reviewer: Schema.String });

/** The size summary view's columns are the view's to name, so its rows stay loose. */
const SummaryRow = Schema.Record(Schema.String, Schema.Unknown);

/** Decodes the rows a query answered; a row the schema refuses is a defect. */
const rowsOf =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (rows: ReadonlyArray<unknown>) =>
    Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(Effect.orDie);

export class Registry extends Context.Service<Registry>()("Registry", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    /** The ladder, cheapest level first, with each rung's harness from its model. */
    const readLadder = Effect.gen(function* () {
      const rungs = yield* sql`SELECT l.rung, l.level, l.model, l.enabled, l.author, l.provider,
            l.unmetered, l.thinking, m.harness
       FROM ladder l JOIN models m USING (model)
      ORDER BY l.level, l.rank`.pipe(Effect.flatMap(rowsOf(RungRow)));
      const [bottom, ...rest] = rungs.map((row): Rung => ({
        name: row.rung,
        harness: row.harness,
        level: row.level,
        model: row.model,
        provider: Option.getOrUndefined(row.provider),
        enabled: row.enabled,
        author: row.author,
        unmetered: row.unmetered,
        thinking: Option.getOrUndefined(row.thinking),
      }));
      if (bottom === undefined) {
        return yield* new RegistryError({ detail: "the ladder table has no rungs" });
      }
      return [bottom, ...rest] as Ladder;
    }).pipe(Effect.mapError(registryError("reading the ladder")));

    /** The ladder joined to `model_status`, for `foreman ladder` to print. */
    const readStatus = Effect.gen(function* () {
      const rows =
        yield* sql`SELECT l.rung, l.level, s.harness, s.model, l.thinking, l.enabled, l.author,
            s.retired, s.status, s.slices, s.succeeded, s.avg_rounds
       FROM ladder l JOIN model_status s USING (model) ORDER BY l.level, l.rank`.pipe(
          Effect.flatMap(rowsOf(StatusRow)),
        );
      return rows.map((row): RungStatus => ({
        rung: row.rung,
        level: row.level,
        harness: row.harness,
        model: row.model,
        thinking: Option.getOrNull(row.thinking),
        enabled: row.enabled,
        state: row.retired ? "retired" : row.enabled ? row.status : "disabled",
        author: row.author,
        slices: row.slices,
        succeeded: row.succeeded,
        avgRounds: Option.getOrNull(row.avg_rounds),
      }));
    }).pipe(Effect.mapError(registryError("reading the ladder's record")));

    /** Every model id the registry knows, for drift checks. */
    const knownModels = Effect.gen(function* () {
      const rows = yield* sql`SELECT model FROM models`.pipe(Effect.flatMap(rowsOf(ModelIdRow)));
      return new Set(rows.map((row) => row.model)) as ReadonlySet<string>;
    }).pipe(Effect.mapError(registryError("reading the models")));

    /** Every model the registry knows, by model id. */
    const readModels = Effect.gen(function* () {
      const rows = yield* sql`SELECT model, harness, retired FROM models ORDER BY model`.pipe(
        Effect.flatMap(rowsOf(ModelRow)),
      );
      return rows.map((row): ModelEntry => ({ ...row }));
    }).pipe(Effect.mapError(registryError("reading the models")));

    /**
     * The reviewers, by name. A reviewer whose model is retired is left out: it is
     * never dispatched, and a drawing pinned to it no longer runs.
     */
    const readReviewers = Effect.gen(function* () {
      const rows = yield* sql`SELECT r.reviewer, r.model, r.thinking, r.provider, m.harness
       FROM reviewers r JOIN models m USING (model)
      WHERE m.retired = 0 ORDER BY r.reviewer`.pipe(Effect.flatMap(rowsOf(ReviewerRow)));
      return rows.map((row): Reviewer => ({
        name: row.reviewer,
        harness: row.harness,
        model: row.model,
        provider: Option.getOrUndefined(row.provider),
        // A reviewer has no allowance switch: the account's reading describes it.
        unmetered: false,
        thinking: Option.getOrUndefined(row.thinking),
      }));
    }).pipe(Effect.mapError(registryError("reading the reviewers")));

    /** The failure for a reviewer name that is not listed: it names the ones that are. */
    const noReviewer = (name: string) =>
      Effect.gen(function* () {
        const names = yield* sql`
          SELECT reviewer FROM reviewers ORDER BY reviewer`.pipe(
          Effect.flatMap(rowsOf(ReviewerNameRow)),
        );
        return yield* new RegistryError({
          detail: `no reviewer ${name}; reviewers: ${names.map((one) => one.reviewer).join(", ") || "none"}`,
        });
      });

    /** Adds a reviewer. Its model must have a row, and its name must be new. */
    const addReviewer = (reviewer: NewReviewer) =>
      Effect.gen(function* () {
        const model = yield* sql`
          SELECT model FROM models WHERE model = ${reviewer.model}`.pipe(
          Effect.flatMap(rowsOf(ModelIdRow)),
        );
        if (model.length === 0) {
          return yield* new RegistryError({
            detail: `model "${reviewer.model}" has no row in the models table`,
          });
        }
        const taken = yield* sql`
          SELECT reviewer FROM reviewers WHERE reviewer = ${reviewer.name}`.pipe(
          Effect.flatMap(rowsOf(ReviewerNameRow)),
        );
        if (taken.length > 0) {
          return yield* new RegistryError({
            detail: `reviewer ${reviewer.name} is already listed`,
          });
        }
        yield* sql`INSERT INTO reviewers (reviewer, model, thinking, provider)
          VALUES (${reviewer.name}, ${reviewer.model},
                  ${Option.getOrNull(reviewer.thinking)},
                  ${Option.getOrNull(reviewer.provider)})`;
      }).pipe(Effect.mapError(registryError("adding a reviewer")));

    /**
     * Sets the thinking level the reviewer named `name` starts at; none passes no
     * flag, so the harness's own default applies. Fails naming the reviewers there
     * are when there is no such reviewer.
     */
    const setReviewerThinking = (name: string, thinking: Option.Option<string>) =>
      Effect.gen(function* () {
        const changed = yield* sql`
          UPDATE reviewers SET thinking = ${Option.getOrNull(thinking)}
           WHERE reviewer = ${name} RETURNING reviewer`.pipe(
          Effect.flatMap(rowsOf(ReviewerNameRow)),
        );
        if (changed.length === 0) return yield* noReviewer(name);
      }).pipe(Effect.mapError(registryError("setting a reviewer's thinking level")));

    /** Removes the reviewer named `name`, or fails naming the reviewers there are. */
    const removeReviewer = (name: string) =>
      Effect.gen(function* () {
        const removed = yield* sql`
          DELETE FROM reviewers WHERE reviewer = ${name} RETURNING reviewer`.pipe(
          Effect.flatMap(rowsOf(ReviewerNameRow)),
        );
        if (removed.length === 0) return yield* noReviewer(name);
      }).pipe(Effect.mapError(registryError("removing a reviewer")));

    /** Landed slices, rounds and cost per success, by model and size. */
    const sizeSummary = Effect.gen(function* () {
      return (yield* sql`
        SELECT * FROM size_summary ORDER BY size, cost_per_success_usd`.pipe(
        Effect.flatMap(rowsOf(SummaryRow)),
      )) as ReadonlyArray<Record<string, unknown>>;
    }).pipe(Effect.mapError(registryError("reading the size summary")));

    /** The ladder as editable rows, for `foreman ladder` and its editor. */
    const readRows = Effect.gen(function* () {
      const rows =
        yield* sql`SELECT rung, level, model, enabled, author, provider, unmetered, note, thinking
       FROM ladder ORDER BY level, rank`.pipe(Effect.flatMap(rowsOf(EditableRow)));
      return rows.map((row): LadderRow => ({
        ...row,
        provider: Option.getOrNull(row.provider),
        note: Option.getOrNull(row.note),
        thinking: Option.getOrNull(row.thinking),
      }));
    }).pipe(Effect.mapError(registryError("reading the ladder rows")));

    /**
     * Replaces the ladder with these rows, sorted by level; inside a level they
     * keep the order given.
     *
     * Rung names are the identity tasks record, so a rename is a different rung and
     * the tasks that recorded the old name stop positioning anything. Ranks are
     * rewritten from the sorted list, so the stored rank is the order of the rows
     * by (level, rank). Everything is validated before anything is written, and the write is one transaction, so a bad edit
     * leaves the ladder as it was.
     */
    const writeRows = (rows: ReadonlyArray<LadderRow>) =>
      Effect.gen(function* () {
        const known = new Set(
          (yield* sql`SELECT model FROM models`.pipe(Effect.flatMap(rowsOf(ModelIdRow)))).map(
            (row) => row.model,
          ),
        );
        const problems = [
          ...(rows.length === 0 ? ["the ladder needs at least one rung"] : []),
          ...rows.flatMap((row, index) =>
            rows.findIndex((other) => other.rung === row.rung) !== index
              ? [`rung "${row.rung}" appears twice`]
              : [],
          ),
          ...rows
            .filter((row) => !known.has(row.model))
            .map(
              (row) =>
                `rung "${row.rung}" names model "${row.model}", which has no row in the models table`,
            ),
          ...rows
            .filter((row) => !Number.isSafeInteger(row.level))
            .map((row) => `rung "${row.rung}" has level ${row.level}, which is not an integer`),
          ...(rows.some((row) => row.enabled) ? [] : ["every rung is disabled"]),
        ];
        if (problems.length > 0) return yield* new RegistryError({ detail: problems.join("; ") });

        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM ladder`;
            yield* Effect.forEach(
              Arr.sort(
                rows,
                Order.mapInput(Order.Number, (row: LadderRow) => row.level),
              ),
              (row, index) =>
                sql`INSERT INTO ladder(rank, level, rung, model, enabled, author, provider, unmetered, note, thinking)
                VALUES (${index + 1}, ${row.level}, ${row.rung}, ${row.model}, ${row.enabled ? 1 : 0},
                        ${row.author ? 1 : 0},
                        ${row.provider}, ${row.unmetered ? 1 : 0}, ${row.note}, ${row.thinking})`,
              { discard: true },
            );
          }),
        );
      }).pipe(Effect.mapError(registryError("writing the ladder")));

    /** Adds `row` to the ladder at `place`, in one validated write. */
    const addRow = (row: Omit<LadderRow, "level">, place: RungPlace) =>
      Effect.gen(function* () {
        const rows = yield* readRows;
        if (rows.some((other) => other.rung === row.rung)) {
          return yield* new RegistryError({ detail: `rung ${row.rung} is already on the ladder` });
        }
        yield* writeRows(yield* placed(rows, row, place));
      });

    /** Moves a rung to `place`, which gives it a new level; nothing else about it changes. */
    const moveRow = (rung: string, place: RungPlace) =>
      Effect.gen(function* () {
        const rows = yield* readRows;
        const row = yield* rowOf(rows, rung);
        if ((place._tag === "Above" || place._tag === "Below") && place.rung === rung) {
          return yield* new RegistryError({ detail: `${rung} cannot move next to itself` });
        }
        const rest = rows.filter((other) => other.rung !== rung);
        yield* writeRows(yield* placed(rest, row, place));
      });

    /** Rewrites one rung with `change`, in one validated write. */
    const changeRow = (rung: string, change: (row: LadderRow) => LadderRow) =>
      Effect.gen(function* () {
        const rows = yield* readRows;
        yield* rowOf(rows, rung);
        yield* writeRows(rows.map((row) => (row.rung === rung ? change(row) : row)));
      });

    return {
      readLadder,
      readStatus,
      knownModels,
      readModels,
      readReviewers,
      addReviewer,
      setReviewerThinking,
      removeReviewer,
      sizeSummary,
      readRows,
      writeRows,
      addRow,
      moveRow,
      changeRow,
    } as const;
  }),
}) {
  /** The registry over a `SqlClient` the caller provides, so services share one connection. */
  static readonly layerSql = Layer.effect(this, this.make);

  /** Default registry: `Registry` over the process's shared connection. */
  static readonly layer = Registry.layerSql.pipe(Layer.provideMerge(store));
}

/** The ladder, cheapest level first, with each rung's harness from its model. */
export const readLadder = Registry.use((registry) => registry.readLadder);

/** The ladder joined to `model_status`, for `foreman ladder` to print. */
export const readStatus = Registry.use((registry) => registry.readStatus);

/** Every model id the registry knows, for drift checks. */
export const knownModels = Registry.use((registry) => registry.knownModels);

/** Every model the registry knows, by model id. */
export const readModels = Registry.use((registry) => registry.readModels);

/** The reviewers, by name; a reviewer whose model is retired is left out. */
export const readReviewers = Registry.use((registry) => registry.readReviewers);

/** Adds a reviewer. Its model must have a row, and its name must be new. */
export const addReviewer = (reviewer: NewReviewer) =>
  Registry.use((registry) => registry.addReviewer(reviewer));

/** Sets a reviewer's thinking level; none passes no flag. */
export const setReviewerThinking = (name: string, thinking: Option.Option<string>) =>
  Registry.use((registry) => registry.setReviewerThinking(name, thinking));

/** Removes the reviewer named `name`, or fails naming the reviewers there are. */
export const removeReviewer = (name: string) =>
  Registry.use((registry) => registry.removeReviewer(name));

/** Landed slices, rounds and cost per success, by model and size. */
export const sizeSummary = Registry.use((registry) => registry.sizeSummary);

/** The ladder as editable rows, for `foreman ladder` and its editor. */
export const readRows = Registry.use((registry) => registry.readRows);

/** Replaces the ladder with these rows, validated, in one transaction. */
export const writeRows = (rows: ReadonlyArray<LadderRow>) =>
  Registry.use((registry) => registry.writeRows(rows));

/** Adds `row` to the ladder at `place`, in one validated write. */
export const addRow = (row: Omit<LadderRow, "level">, place: RungPlace) =>
  Registry.use((registry) => registry.addRow(row, place));

/** Moves a rung to `place`, which gives it a new level. */
export const moveRow = (rung: string, place: RungPlace) =>
  Registry.use((registry) => registry.moveRow(rung, place));

/** Rewrites one rung with `change`, in one validated write. */
export const changeRow = (rung: string, change: (row: LadderRow) => LadderRow) =>
  Registry.use((registry) => registry.changeRow(rung, change));

/** The row named `rung`, or a failure that lists the rungs there are. */
const rowOf = (rows: ReadonlyArray<LadderRow>, rung: string) => {
  const row = rows.find((other) => other.rung === rung);
  return row === undefined
    ? Effect.fail(
        new RegistryError({
          detail: `no rung ${rung}; rungs: ${rows.map((other) => other.rung).join(", ")}`,
        }),
      )
    : Effect.succeed(row);
};

/**
 * `rows` with `row` put at `place`. A `Level` place joins that level, ranked
 * last in it. Any other place is a level of its own: it takes the level the
 * place names, and every level from there up moves up one to make room. The
 * level a moved rung leaves may stay empty, which orders nothing.
 */
const placed = (rows: ReadonlyArray<LadderRow>, row: Omit<LadderRow, "level">, place: RungPlace) =>
  Effect.gen(function* () {
    if (place._tag === "Level") return [...rows, { ...row, level: place.level }];
    const level =
      place._tag === "Bottom"
        ? (rows[0]?.level ?? 1)
        : (yield* rowOf(rows, place.rung)).level + (place._tag === "Above" ? 1 : 0);
    return [
      ...rows.map((other) => (other.level >= level ? { ...other, level: other.level + 1 } : other)),
      { ...row, level },
    ];
  });

/** Parses the editor's text: a JSONC array of rows, with comments allowed. */
export const parseRows = (text: string): ReadonlyArray<LadderRow> => {
  const raw: unknown = Bun.JSONC.parse(text);
  return Schema.decodeUnknownSync(Schema.Array(RowFile))(raw).map((row) => ({
    rung: row.rung,
    level: row.level,
    model: row.model,
    enabled: row.enabled,
    author: row.author,
    provider: row.provider ?? null,
    unmetered: row.unmetered,
    note: row.note ?? null,
    thinking: row.thinking ?? null,
  }));
};

/** The editor's text: one object per rung, so a reorder is moving a block. */
export const renderRows = (rows: ReadonlyArray<LadderRow>): string =>
  [
    "// The ladder, cheapest level first. `level` groups the rungs: levels climb in",
    "// number, and the rungs of one level share the author work. Inside a level,",
    "// order is the rank; move a block to re-rank it.",
    "// A rung's name is what tasks record: renaming one makes a new rung.",
    "// `model` must already have a row in the registry's models table.",
    "// `thinking` is the level the rung's harness is started at; a rung without",
    "// one passes no flag, so the harness's own default applies.",
    "// `author: false` keeps a rung out of the author pick without retiring it.",
    "[",
    ...rows.map(
      (row) =>
        "  " +
        JSON.stringify({
          rung: row.rung,
          level: row.level,
          model: row.model,
          thinking: row.thinking ?? undefined,
          enabled: row.enabled,
          ...(row.author ? {} : { author: false }),
          ...(row.provider ? { provider: row.provider } : {}),
          ...(row.unmetered ? { unmetered: true } : {}),
          ...(row.note ? { note: row.note } : {}),
        }) +
        ",",
    ),
    "]",
    "",
  ].join("\n");

const RowFile = Schema.Struct({
  rung: Schema.NonEmptyString,
  level: Schema.Int,
  model: Schema.NonEmptyString,
  thinking: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  author: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  provider: Schema.optional(Schema.NullOr(Schema.String)),
  unmetered: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * What a store failure says, for a message an operator reads.
 *
 * A `SqlError` stringifies as "Failed to execute statement" alone; the
 * database's own words (a lock, a missing table) are on its `reason.cause`.
 */
export function reasonOf(error: unknown): string {
  const cause = (error as { reason?: { cause?: unknown } } | null)?.reason?.cause;
  if (cause instanceof Error) return cause.message;
  return cause === undefined ? String(error) : String(cause);
}

/** Names the step a store failure came from; a `RegistryError` passes through. */
export function registryError(step: string) {
  return (cause: unknown): RegistryError =>
    cause instanceof RegistryError
      ? cause
      : new RegistryError({ detail: `${step} in the task store: ${reasonOf(cause)}` });
}
