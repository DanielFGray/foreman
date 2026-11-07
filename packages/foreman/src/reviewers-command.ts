import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Option, Schema } from "effect";
import { launchArguments } from "./harness.ts";
import { providerOf } from "./ladder.ts";
import { addReviewer, readReviewers, removeReviewer, setReviewerThinking } from "./registry.ts";
import type { Reviewer } from "./reviewers.ts";

/**
 * `foreman reviewers`: read and change the reviewers, the list a pipeline's
 * review block takes its reader from.
 *
 * A reviewer is a model with its own thinking level and account, apart from
 * the ladder: a model can be a rung, a reviewer, both or neither.
 * `foreman reviewers --json` prints the list for other tools. The pane's
 * verbs (add, remove, thinking) are exported Effects the CLI and the coming
 * UI contract both call.
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
  Command.withSubcommands([add(), remove(), thinking()]),
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

/** Add a reviewer. `name` defaults to the model id at the CLI. */
export const reviewersAdd = (input: {
  readonly name: string;
  readonly model: string;
  readonly thinking: Option.Option<string>;
  readonly provider: Option.Option<string>;
}) =>
  addReviewer({
    name: input.name,
    model: input.model,
    thinking: input.thinking,
    provider: input.provider,
  }).pipe(Effect.as(input.name));

/** Remove the reviewer named `name`. */
export const reviewersRemove = (input: { readonly name: string }) =>
  removeReviewer(input.name).pipe(Effect.as(input.name));

/**
 * Set a reviewer's thinking level. `Option.none` clears it so the harness's
 * own default applies.
 */
export const reviewersThinking = (input: {
  readonly name: string;
  readonly thinking: Option.Option<string>;
}) =>
  setReviewerThinking(input.name, input.thinking).pipe(
    Effect.as({
      name: input.name,
      thinking: Option.getOrElse(input.thinking, () => "none"),
    }),
  );

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
        yield* reviewersAdd({ name: named, model, thinking, provider });
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
        yield* reviewersRemove({ name });
        yield* Console.log(`${name}: removed from the reviewers`);
      }),
  ).pipe(Command.withDescription("Remove a reviewer"));
}

function thinking() {
  return Command.make(
    "thinking",
    {
      name: Argument.String("name").pipe(Argument.withDescription("A reviewer's name")),
      thinking: Argument.String("thinking").pipe(
        Argument.withSchema(Schema.NonEmptyString),
        Argument.withDescription(
          "How hard it thinks, such as low, medium or high; none passes no flag, so the harness's own default applies",
        ),
      ),
    },
    ({ name, thinking }) =>
      Effect.gen(function* () {
        const level = thinking === "none" ? Option.none() : Option.some(thinking);
        const result = yield* reviewersThinking({ name, thinking: level });
        yield* Console.log(`${result.name}: thinking ${result.thinking}`);
      }),
  ).pipe(
    Command.withDescription(
      "Set the thinking level a reviewer starts at, or none for the harness's own default",
    ),
  );
}
