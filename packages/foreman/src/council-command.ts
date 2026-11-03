import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect } from "effect";
import { readCouncil, setCouncil } from "./registry.ts";

/**
 * `foreman council`: read and change which models sit on the council.
 *
 * The council is a switch on each model in the registry, apart from the
 * ladder: a model can be a worker, a council member, both or neither. The
 * council skill reads its roster from `foreman council --json`.
 */
export const councilCommand = Command.make(
  "council",
  { json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Emit JSON")) },
  ({ json }) =>
    Effect.gen(function* () {
      const members = yield* readCouncil;
      if (json) return yield* Console.log(JSON.stringify(members, null, 2));
      if (members.length === 0) return yield* Console.log("the council has no members");
      for (const member of members) {
        yield* Console.log(`${member.harness} ${member.args.join(" ")}`);
      }
    }),
).pipe(
  Command.withDescription("List the council members and the arguments that launch each one"),
  Command.withSubcommands([toggle("add"), toggle("remove")]),
);

function toggle(name: "add" | "remove") {
  return Command.make(
    name,
    {
      model: Argument.String("model").pipe(
        Argument.withDescription("A model id with a row in the registry's models table"),
      ),
    },
    ({ model }) =>
      Effect.gen(function* () {
        yield* setCouncil(model, name === "add");
        yield* Console.log(`${model}: ${name === "add" ? "on" : "off"} the council`);
      }),
  ).pipe(
    Command.withDescription(
      name === "add" ? "Put a model on the council" : "Take a model off the council",
    ),
  );
}
