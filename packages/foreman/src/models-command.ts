import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Option } from "effect";
import { catalogLayer, loadCatalog } from "./model-advice-catalog.ts";
import { candidatesFrom, readLogins } from "./model-candidates.ts";
import { addModel, readModels } from "./registry.ts";

/**
 * `foreman models`: seed and list the registry's models table.
 *
 * A cold store has a schema and no rows. Ladder and reviewer commands need a
 * model row first, so this is the bootstrap step before either.
 */
export const modelsCommand = Command.make(
  "models",
  { json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Emit JSON")) },
  ({ json }) =>
    Effect.gen(function* () {
      const models = yield* readModels;
      if (json) return yield* Console.log(JSON.stringify(models, null, 2));
      if (models.length === 0) return yield* Console.log("there are no models");
      for (const entry of models) {
        const state = entry.retired ? " (retired)" : "";
        yield* Console.log(`${entry.model}  ${entry.harness}${state}`);
      }
    }),
).pipe(
  Command.withDescription("List the models the registry knows"),
  Command.withSubcommands([add(), candidates()]),
);

function add() {
  return Command.make(
    "add",
    {
      model: Argument.String("model").pipe(
        Argument.withDescription("The exact harness id, such as opencode/claude-sonnet-5"),
      ),
      harness: Flag.String("harness").pipe(
        Flag.withDescription("The program that runs it: claude, codex, cursor, opencode, pi, …"),
      ),
      provider: Flag.String("provider").pipe(
        Flag.withDescription("The account / catalog provider the model spends"),
      ),
      pool: Flag.String("pool").pipe(
        Flag.withDescription("Quota pool name; created when it does not exist yet"),
      ),
      limitScope: Flag.Literals("limit-scope", ["pool", "model"]).pipe(
        Flag.optional,
        Flag.withDescription("Whether the allowance is the pool's or the model's (default: pool)"),
      ),
      modelsDev: Flag.String("models-dev").pipe(
        Flag.optional,
        Flag.withDescription("The models.dev identity, `provider/model`, for catalog prices"),
      ),
    },
    ({ model, harness, provider, pool, limitScope, modelsDev }) =>
      Effect.gen(function* () {
        yield* addModel({
          model,
          harness,
          provider,
          pool,
          limitScope: Option.getOrElse(limitScope, (): "pool" | "model" => "pool"),
          modelsDev,
        });
        yield* Console.log(`${model}: added (${harness}, pool ${pool})`);
      }),
  );
}

/**
 * Models the operator could register: the models.dev catalog, kept to the
 * accounts they are signed in to (`readLogins`) and minus the registry's own.
 * Each row carries the flags `models add` takes.
 */
function candidates() {
  return Command.make(
    "candidates",
    {
      json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Emit JSON")),
      catalog: Flag.String("catalog").pipe(
        Flag.optional,
        Flag.withDescription("Local models.dev api.json path (offline / tests)"),
      ),
    },
    ({ json, catalog }) =>
      Effect.gen(function* () {
        const loaded = yield* loadCatalog(catalog);
        const logins = yield* readLogins(process.env["HOME"] ?? "");
        const registered = new Set((yield* readModels).map((entry) => entry.model));
        const found = candidatesFrom(loaded.catalog, logins, registered);
        if (json) return yield* Console.log(JSON.stringify(found, null, 2));
        if (found.length === 0) return yield* Console.log("there are no candidates");
        for (const one of found) yield* Console.log(`${one.model}  ${one.harness}  ${one.pool}`);
      }).pipe(Effect.provide(catalogLayer)),
  ).pipe(
    Command.withDescription(
      "List catalog models the operator's logins could run and the registry lacks",
    ),
  );
}
