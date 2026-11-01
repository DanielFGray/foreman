import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import type { Ladder, Rung } from "./ladder.ts";

/**
 * The model registry: the ladder, and the facts about each model on it.
 *
 * It is the `ladder` and `models` tables of the trials database the herd skill
 * also uses (`~/.agents/model-trials.db`), so the order of the models, their
 * launch settings and the record of how each one fared live in one file. Foreman
 * reads the ladder from it on every start and refuses to run without it: a
 * second copy of the order in a config file is a copy that can disagree.
 *
 * Models themselves (harness, pool, thinking level) are rows the herd skill's
 * `schema-registry.sql` seeds. This module edits only the ladder, which is the
 * part an operator reorders, enables and disables.
 */

export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/** The registry's path: `$FOREMAN_REGISTRY`, else the herd skill's database. */
export const registryPath = (): string =>
  process.env["FOREMAN_REGISTRY"] ?? `${process.env["HOME"] ?? ""}/.agents/model-trials.db`;

/** One ladder row as an operator edits it. Position in the list is the rank. */
export interface LadderRow {
  readonly rung: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly provider: string | null;
  readonly unmetered: boolean;
  readonly note: string | null;
}

/** The ladder, cheapest first, with each rung's launch settings from its model. */
export const readLadder = (path: string): Ladder => {
  const db = open(path, false);
  try {
    const rungs = db
      .query(
        `SELECT l.rung, l.model, l.enabled, l.provider, l.unmetered, m.harness, m.thinking
           FROM ladder l JOIN models m USING (model)
          ORDER BY l.rank`,
      )
      .all() as ReadonlyArray<{
      rung: string;
      model: string;
      enabled: number;
      provider: string | null;
      unmetered: number;
      harness: string;
      thinking: string;
    }>;
    const [bottom, ...rest] = rungs.map((row): Rung => ({
      name: row.rung,
      harness: row.harness,
      model: row.model,
      provider: row.provider ?? undefined,
      enabled: row.enabled !== 0,
      unmetered: row.unmetered !== 0 ? true : undefined,
      thinking: row.thinking,
    }));
    if (bottom === undefined) {
      throw new RegistryError({ detail: `the ladder table in ${path} has no rungs` });
    }
    return [bottom, ...rest];
  } catch (cause) {
    throw cause instanceof RegistryError
      ? cause
      : new RegistryError({ detail: `reading the ladder from ${path}: ${cause}` });
  } finally {
    db.close();
  }
};

/** One rung with the record the registry holds for its model. */
export interface RungStatus {
  readonly rung: string;
  readonly harness: string;
  readonly model: string;
  readonly thinking: string;
  /** `retired`, `disabled`, or the model's derived `proven` / `trial`. */
  readonly state: string;
  readonly slices: number;
  readonly succeeded: number;
  readonly avgRounds: number | null;
}

/** The ladder joined to `model_status`, for `foreman ladder` to print. */
export const readStatus = (path: string): ReadonlyArray<RungStatus> => {
  const db = open(path, false);
  try {
    return (
      db
        .query(
          `SELECT l.rung, s.harness, s.model, s.thinking, l.enabled, s.retired, s.status,
                  s.slices, s.succeeded, s.avg_rounds
             FROM ladder l JOIN model_status s USING (model) ORDER BY l.rank`,
        )
        .all() as ReadonlyArray<{
        rung: string;
        harness: string;
        model: string;
        thinking: string;
        enabled: number;
        retired: number;
        status: string;
        slices: number;
        succeeded: number;
        avg_rounds: number | null;
      }>
    ).map((row) => ({
      rung: row.rung,
      harness: row.harness,
      model: row.model,
      thinking: row.thinking,
      state: row.retired ? "retired" : row.enabled ? row.status : "disabled",
      slices: row.slices,
      succeeded: row.succeeded,
      avgRounds: row.avg_rounds,
    }));
  } finally {
    db.close();
  }
};

/** Every model id the registry knows, for drift checks. */
export const knownModels = (path: string): ReadonlySet<string> => {
  const db = open(path, false);
  try {
    return new Set(
      (db.query(`SELECT model FROM models`).all() as ReadonlyArray<{ model: string }>).map(
        (row) => row.model,
      ),
    );
  } finally {
    db.close();
  }
};

/** Landed slices, rounds and cost per success, by model and size. */
export const sizeSummary = (path: string): ReadonlyArray<Record<string, unknown>> => {
  const db = open(path, false);
  try {
    return db
      .query(`SELECT * FROM size_summary ORDER BY size, cost_per_success_usd`)
      .all() as ReadonlyArray<Record<string, unknown>>;
  } finally {
    db.close();
  }
};

/** The ladder as editable rows, for `foreman ladder` and its editor. */
export const readRows = (path: string): ReadonlyArray<LadderRow> => {
  const db = open(path, false);
  try {
    return (
      db
        .query(`SELECT rung, model, enabled, provider, unmetered, note FROM ladder ORDER BY rank`)
        .all() as ReadonlyArray<{
        rung: string;
        model: string;
        enabled: number;
        provider: string | null;
        unmetered: number;
        note: string | null;
      }>
    ).map((row) => ({
      ...row,
      enabled: row.enabled !== 0,
      unmetered: row.unmetered !== 0,
    }));
  } finally {
    db.close();
  }
};

/**
 * Replaces the ladder with these rows, in this order.
 *
 * Rung names are the identity tasks record, so a rename is a different rung and
 * the tasks that recorded the old name stop positioning anything; ranks are
 * only the order and are rewritten from the list. Everything is validated
 * before anything is written, and the write is one transaction, so a bad edit
 * leaves the ladder as it was.
 */
export const writeRows = (path: string, rows: ReadonlyArray<LadderRow>): void => {
  const db = open(path, true);
  try {
    const known = new Set(
      (db.query(`SELECT model FROM models`).all() as ReadonlyArray<{ model: string }>).map(
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
      ...(rows.some((row) => row.enabled) ? [] : ["every rung is disabled"]),
    ];
    if (problems.length > 0) throw new RegistryError({ detail: problems.join("; ") });

    db.transaction(() => {
      db.query(`DELETE FROM ladder`).run();
      const insert = db.query(
        `INSERT INTO ladder(rank, rung, model, enabled, provider, unmetered, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      rows.forEach((row, index) =>
        insert.run(
          index + 1,
          row.rung,
          row.model,
          row.enabled ? 1 : 0,
          row.provider,
          row.unmetered ? 1 : 0,
          row.note,
        ),
      );
    })();
  } finally {
    db.close();
  }
};

/** Parses the editor's text: a JSONC array of rows, with comments allowed. */
export const parseRows = (text: string): ReadonlyArray<LadderRow> => {
  const raw: unknown = Bun.JSONC.parse(text);
  return Schema.decodeUnknownSync(Schema.Array(RowFile))(raw).map((row) => ({
    rung: row.rung,
    model: row.model,
    enabled: row.enabled,
    provider: row.provider ?? null,
    unmetered: row.unmetered,
    note: row.note ?? null,
  }));
};

/** The editor's text: one object per rung, so a reorder is moving a block. */
export const renderRows = (rows: ReadonlyArray<LadderRow>): string =>
  [
    "// The ladder, cheapest first. Order is the rank; move a block to re-rank it.",
    "// A rung's name is what tasks record: renaming one makes a new rung.",
    "// `model` must already have a row in the registry's models table.",
    "[",
    ...rows.map(
      (row) =>
        "  " +
        JSON.stringify({
          rung: row.rung,
          model: row.model,
          enabled: row.enabled,
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
  model: Schema.NonEmptyString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  provider: Schema.optional(Schema.NullOr(Schema.String)),
  unmetered: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});

const open = (path: string, write: boolean): Database => {
  try {
    return new Database(path, write ? { create: false, readwrite: true } : { readonly: true });
  } catch (cause) {
    throw new RegistryError({
      detail: `no model registry at ${path} (${cause}); it is the herd skill's trials database — set FOREMAN_REGISTRY to use another`,
    });
  }
};
