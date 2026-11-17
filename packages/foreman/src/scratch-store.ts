import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { connectionAt, Runs } from "tasks";
import { addModel, addReviewer, Registry, writeRows } from "./registry.ts";
import type { Rung } from "./ladder.ts";
import type { Reviewer } from "./reviewers.ts";

/**
 * A task store in a temporary file, for tests: the migration makes the schema,
 * so a test seeds rows and never restates a table.
 *
 * `layer` is one connection per use of the layer; `cleanup` removes the file.
 */
export const scratchStore = () => {
  const directory = mkdtempSync(join(tmpdir(), "foreman-store-"));
  const file = join(directory, "store.db");
  return {
    file,
    layer: connectionAt(file),
    /** The connection with the registry over it. */
    registry: Registry.layerSql.pipe(Layer.provideMerge(connectionAt(file))),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
};

/**
 * Runs a SQL script of plain statements. A statement ends at a semicolon at the
 * end of a line, and a line starting with \`--\` is a comment.
 */
export const seed = (script: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const statements = script
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(/;\s*\n/)
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");
    yield* Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true });
  });

/** Runs `effect` on a fresh scratch store seeded with `script`, then removes the file. The run records and the registry are provided beside the connection. */
export const withStore = <A, E>(
  script: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient | Runs | Registry>,
): Promise<A> => {
  const store = scratchStore();
  return seed(script)
    .pipe(
      Effect.andThen(effect),
      Effect.provide(Registry.layerSql.pipe(Layer.provideMerge(Runs.layerAt(store.file)))),
      Effect.runPromise,
    )
    .finally(store.cleanup);
};

/**
 * A layer holding the registry over a scratch store, seeded with these rungs
 * and reviewers through the registry's own writes. A tick reads its ladder
 * from this layer, so a test changes the ladder with the same writes a command
 * makes. Each model is filed under a pool named for its harness.
 *
 * The store's directory is removed when the layer's scope closes. Two seats
 * naming one model with different harnesses fail the build: the model row
 * holds one harness, so the second would be dropped without a word.
 */
export const registryOf = (rungs: ReadonlyArray<Rung>, reviewers: ReadonlyArray<Reviewer>) =>
  Layer.unwrap(
    Effect.acquireRelease(Effect.sync(scratchStore), (store) => Effect.sync(store.cleanup)).pipe(
      Effect.map((store) =>
        Layer.effectDiscard(seeding(rungs, reviewers)).pipe(
          Layer.provideMerge(Registry.layerSql.pipe(Layer.provideMerge(store.layer))),
        ),
      ),
    ),
  );

const seeding = (rungs: ReadonlyArray<Rung>, reviewers: ReadonlyArray<Reviewer>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const seats = [...rungs, ...reviewers];
    const harnesses = [...new Set(seats.map((seat) => seat.harness))];
    yield* Effect.forEach(
      harnesses,
      (harness) =>
        sql`INSERT INTO pools(pool, harness, provider_default) VALUES (${harness}, ${harness}, ${harness})`,
      { discard: true },
    );
    const models = new Map<string, (typeof seats)[number]>();
    for (const seat of seats) {
      const model = seat.model ?? seat.name;
      const seen = models.get(model);
      if (seen !== undefined && seen.harness !== seat.harness) {
        return yield* Effect.die(
          new Error(`model ${model} is seated on harnesses ${seen.harness} and ${seat.harness}`),
        );
      }
      models.set(model, seat);
    }
    yield* Effect.forEach(
      [...models],
      ([model, seat]) =>
        addModel({
          model,
          harness: seat.harness,
          provider: seat.provider ?? seat.harness,
          pool: seat.harness,
          limitScope: "model",
          modelsDev: Option.none(),
        }),
      { discard: true },
    );
    yield* Effect.forEach(
      reviewers,
      (reviewer) =>
        addReviewer({
          name: reviewer.name,
          model: reviewer.model ?? reviewer.name,
          thinking: Option.fromNullishOr(reviewer.thinking),
          provider: Option.fromNullishOr(reviewer.provider),
        }),
      { discard: true },
    );
    yield* writeRows(
      rungs.map((rung) => ({
        rung: rung.name,
        level: rung.level,
        model: rung.model ?? rung.name,
        enabled: rung.enabled,
        author: rung.author,
        provider: rung.provider ?? null,
        unmetered: rung.unmetered,
        note: null,
        thinking: null,
      })),
    );
  });
