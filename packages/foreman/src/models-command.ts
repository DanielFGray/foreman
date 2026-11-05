import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Option } from "effect";
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
  Command.withSubcommands([add()]),
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
    },
    ({ model, harness, provider, pool, limitScope }) =>
      Effect.gen(function* () {
        yield* addModel({
          model,
          harness,
          provider,
          pool,
          limitScope: Option.getOrElse(limitScope, (): "pool" | "model" => "pool"),
        });
        yield* Console.log(`${model}: added (${harness}, pool ${pool})`);
      }),
  ).pipe(
    Command.withDescription(
      "Add a model, creating its pool when missing; run this before ladder or reviewers add",
    ),
  );
}
