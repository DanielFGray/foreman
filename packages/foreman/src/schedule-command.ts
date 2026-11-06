import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Option, Schema } from "effect";
import {
  addSchedule,
  Policy,
  policyPath,
  readPolicy,
  removeSchedule,
  schedulesOf,
  updatePolicy,
  type Policy as PolicyType,
  type Schedule,
} from "./policy.ts";

/**
 * `foreman schedule`: read and change the recurring patterns a project keeps.
 *
 * Every write goes through `updatePolicy`, as `foreman policy` does, so the
 * dispatcher reads the change on its next tick. A schedule is the operator's
 * intention, not work: filing spends nothing until the author gate.
 */

const projectArg = Argument.String("project").pipe(
  Argument.withDescription("The project whose schedules to change"),
);

const nameArg = Argument.String("name").pipe(
  Argument.withDescription("The schedule's name; becomes the schedule:<name> label"),
);

const listProject = Argument.String("project").pipe(
  Argument.withDescription("List only this project's schedules"),
  Argument.optional,
);

const json = Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Emit JSON"));

const everyLanded = Flag.Int("every-landed").pipe(
  Flag.withDescription("File after this many distinct tasks land (committed or answered)"),
);

const title = Flag.String("title").pipe(
  Flag.withDescription("The filed task's title; may use {{ project }} and {{ since }}"),
);

const template = Flag.String("template").pipe(
  Flag.withDescription("The instructions file in prompts/ the filed task's author reads"),
);

const labels = Flag.String("label").pipe(
  Flag.withAlias("l"),
  Flag.withDescription("A label on the filed task, beside schedule:<name>; repeat it for more"),
  Flag.atLeast(0),
);

const list = Command.make("list", { project: listProject, json }, (args) =>
  Effect.gen(function* () {
    const read = yield* readPolicy(policyPath());
    if (read.error !== undefined) yield* Console.error(read.error);
    const only = Option.getOrUndefined(args.project);
    const rows =
      only === undefined
        ? Object.entries(read.policy.projects).flatMap(([project, entry]) =>
            (entry.schedules ?? []).map((schedule) => ({ project, schedule })),
          )
        : schedulesOf(read.policy, only).map((schedule) => ({ project: only, schedule }));
    if (args.json) {
      return yield* Console.log(
        JSON.stringify(
          rows.map(({ project, schedule }) => ({ project, ...schedule })),
          null,
          2,
        ),
      );
    }
    if (rows.length === 0) {
      return yield* Console.log(only === undefined ? "no schedules" : `no schedules in ${only}`);
    }
    for (const { project, schedule } of rows) {
      const labelText =
        (schedule.labels ?? []).length === 0 ? "" : ` labels ${(schedule.labels ?? []).join(",")}`;
      yield* Console.log(
        `${project}  ${schedule.name}  every-landed ${schedule.every.landed}  template ${schedule.template}  ${schedule.title}${labelText}`,
      );
    }
  }),
).pipe(Command.withDescription("Print the schedules in the policy file"));

const add = Command.make(
  "add",
  { project: projectArg, name: nameArg, everyLanded, title, template, labels },
  (args) => {
    // The operator may name the file with or without .md; prompts/ stores the
    // stem, and Prompts.template adds the suffix when it reads.
    const template = args.template.replace(/\.md$/i, "");
    const schedule: Schedule = {
      name: args.name,
      every: { landed: args.everyLanded },
      title: args.title,
      template,
      labels: args.labels,
    };
    return write((policy) => addSchedule(policy, args.project, schedule));
  },
).pipe(
  Command.withDescription(
    "Add or replace a schedule for a project: files a task from a template after N landings",
  ),
);

const remove = Command.make("remove", { project: projectArg, name: nameArg }, (args) =>
  write((policy) => removeSchedule(policy, args.project, args.name)),
).pipe(Command.withDescription("Remove one schedule of a project"));

export const scheduleCommand = Command.make("schedule", {}).pipe(
  Command.withDescription(`Read and change recurring task patterns (${policyPath()})`),
  Command.withSubcommands([list, add, remove]),
);

const write = (edit: (policy: PolicyType) => PolicyType) =>
  updatePolicy(policyPath(), edit).pipe(
    Effect.flatMap((policy) =>
      Schema.encodeEffect(Policy)(policy).pipe(
        Effect.flatMap((encoded) => Console.log(JSON.stringify(encoded, null, 2))),
      ),
    ),
  );
