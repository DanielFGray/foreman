import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Option, Schema } from "effect";
import { launchArguments } from "./harness.ts";
import { providerOf } from "./ladder.ts";
import { addReviewer, readReviewers, removeReviewer } from "./registry.ts";
import type { Reviewer } from "./reviewers.ts";

/**
 * `foreman reviewers`: read and change the reviewers, the list a pipeline's
 * review block takes its reader from.
 *
 * A reviewer is a model with its own thinking level and account, apart from
 * the ladder: a model can be a rung, a reviewer, both or neither. The council
 * skill convenes the same list from `foreman reviewers --json`.
 */
export const reviewersCommand = Command.make(
  "reviewers",
  { json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Emit JSON")) },
  ({ json }) =>
    Effect.gen(function* () {
      const reviewers = (yield* readReviewers).map(reviewerJson);
      if (json) return yield* Console.log(JSON.stringify(reviewers, null, 2));
      if (reviewers.length === 0) return yield* Console.log("there are no reviewers");
      for (const reviewer of reviewers) {
        yield* Console.log(`${reviewer.name}  ${reviewer.harness} ${reviewer.args.join(" ")}`);
      }
    }),
).pipe(
  Command.withDescription("List the reviewers and the arguments that launch each one"),
  Command.withSubcommands([add(), remove()]),
);

/**
 * A reviewer as the command prints it: the arguments name its model and its
 * thinking level, and `provider` is the account it spends. The read-only
 * flags are the caller's: they depend on what the caller asks the reviewer to
 * do, not on the model.
 */
export const reviewerJson = (reviewer: Reviewer) => ({
  name: reviewer.name,
  model: reviewer.model,
  harness: reviewer.harness,
  thinking: reviewer.thinking ?? null,
  provider: providerOf(reviewer) ?? null,
  args: launchArguments({
    kind: reviewer.harness,
    model: reviewer.model,
    thinking: reviewer.thinking,
  }),
});

function add() {
  return Command.make(
    "add",
    {
      model: Argument.String("model").pipe(
        Argument.withDescription("A model id with a row in the registry's models table"),
      ),
      name: Flag.String("name").pipe(
        Flag.optional,
        Flag.withDescription("The name review runs record (default: the model id)"),
      ),
      thinking: Flag.String("thinking").pipe(
        Flag.withSchema(Schema.NonEmptyString),
        Flag.optional,
        Flag.withDescription(
          "How hard it thinks, such as low, medium or high (default: no flag, so the harness's own default)",
        ),
      ),
      provider: Flag.String("provider").pipe(
        Flag.optional,
        Flag.withDescription("The account it spends, where the model id does not say"),
      ),
    },
    ({ model, name, thinking, provider }) =>
      Effect.gen(function* () {
        const named = Option.getOrElse(name, () => model);
        yield* addReviewer({ name: named, model, thinking, provider });
        yield* Console.log(`${named}: added to the reviewers`);
      }),
  ).pipe(Command.withDescription("Add a reviewer"));
}

function remove() {
  return Command.make(
    "remove",
    { name: Argument.String("name").pipe(Argument.withDescription("A reviewer's name")) },
    ({ name }) =>
      Effect.gen(function* () {
        yield* removeReviewer(name);
        yield* Console.log(`${name}: removed from the reviewers`);
      }),
  ).pipe(Command.withDescription("Remove a reviewer"));
}
