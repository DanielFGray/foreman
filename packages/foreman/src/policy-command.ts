import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Option, Schema } from "effect";
import {
  clearProject,
  grant,
  pauseProject,
  setProjectStep,
  setProjectTracker,
  Policy,
  policyPath,
  readPolicy,
  STEP_MODES,
  STEPS,
  TRACKERS,
  updatePolicy,
  type Policy as PolicyType,
} from "./policy.ts";

/**
 * `foreman policy`: read and change what the fleet may do by itself.
 *
 * Every subcommand writes through `updatePolicy` and prints the policy that
 * results, so the panel and a person at the shell change the file the same
 * way and see the same answer. The dispatcher reads the file on its next tick.
 */

const show = Command.make("show", {}, () =>
  Effect.gen(function* () {
    const read = yield* readPolicy(policyPath());
    if (read.error !== undefined) yield* Console.error(read.error);
    yield* print(read.policy);
  }),
).pipe(Command.withDescription("Print the policy the dispatcher reads"));

const projectFlag = Flag.String("project").pipe(
  Flag.withDescription("Apply to this project only; the whole fleet when absent"),
  Flag.optional,
);

const projectOf = (flag: Option.Option<string>): string | undefined => Option.getOrUndefined(flag);

const pauseOrResume = (name: "pause" | "resume") => {
  const paused = name === "pause";
  return Command.make(name, { project: projectFlag }, ({ project }) => {
    const only = projectOf(project);
    return write((policy) =>
      only === undefined ? { ...policy, paused } : pauseProject(policy, only, paused),
    );
  }).pipe(
    Command.withDescription(
      paused
        ? "Stop every step, grants included, until resumed; with --project, stop that project only"
        : "Undo pause; the default and the grants apply again; with --project, resume that project only",
    ),
  );
};

const step = Argument.Literals("step", STEPS);
const setting = Argument.Literals("setting", STEP_MODES);

const set = Command.make("set", { step, setting, project: projectFlag }, (args) => {
  const only = projectOf(args.project);
  return write((policy) =>
    only === undefined
      ? { ...policy, default: { ...policy.default, [args.step]: args.setting } }
      : setProjectStep(policy, only, args.step, args.setting),
  );
}).pipe(
  Command.withDescription(
    "Set one step for every task, or one project's tasks with --project: on runs it, ask waits for one approval per task, off does nothing",
  ),
);

const clear = Command.make("clear", { project: Flag.String("project") }, ({ project }) =>
  write((policy) => clearProject(policy, project)),
).pipe(
  Command.withDescription(
    "Drop a project's step and pause settings, so it follows the default again; its tracker stays",
  ),
);

const tracker = Command.make(
  "tracker",
  { tracker: Argument.Literals("tracker", TRACKERS), project: Flag.String("project") },
  (args) => write((policy) => setProjectTracker(policy, args.project, args.tracker)),
).pipe(
  Command.withDescription(
    "Choose where a project's tasks live: prog (the default), a GitHub repo's issues, or Linear",
  ),
);

const count = Argument.Int("count").pipe(
  Argument.withSchema(Schema.Int.check(Schema.isGreaterThan(0))),
);

const slots = Command.make("slots", { count }, ({ count }) =>
  write((policy) => ({ ...policy, slots: count })),
).pipe(Command.withDescription("Set how many agents may work at once"));

const scope = Argument.String("scope").pipe(
  Argument.withDescription("A task id, or an epic id to cover every task under it"),
);

const remaining = Flag.Int("count").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isGreaterThan(0))),
  Flag.withDescription("How many distinct tasks the grant may take on; no limit when absent"),
  Flag.optional,
);

const grantCommand = Command.make(
  "grant",
  { scope, steps: step.pipe(Argument.atLeast(1)), remaining },
  (args) =>
    write((policy) =>
      grant(
        policy,
        args.scope,
        args.steps,
        args.remaining._tag === "Some" ? args.remaining.value : undefined,
      ),
    ),
).pipe(
  Command.withDescription(
    "Allow steps for one task or epic beyond the default; `grant ts-1 land --count 1` lands one approved task",
  ),
);

const revoke = Command.make("revoke", { scope }, ({ scope }) =>
  write((policy) => ({
    ...policy,
    grants: policy.grants.filter((g) => g.scope !== scope),
  })),
).pipe(Command.withDescription("Remove the grant on a task or epic"));

export const policyCommand = Command.make("policy", {}).pipe(
  Command.withDescription(`Read and change what the fleet may do by itself (${policyPath()})`),
  Command.withSubcommands([
    show,
    pauseOrResume("pause"),
    pauseOrResume("resume"),
    set,
    clear,
    tracker,
    slots,
    grantCommand,
    revoke,
  ]),
);

const write = (edit: (policy: PolicyType) => PolicyType) =>
  updatePolicy(policyPath(), edit).pipe(Effect.flatMap(print));

const print = (policy: PolicyType) =>
  Schema.encodeEffect(Policy)(policy).pipe(
    Effect.flatMap((encoded) => Console.log(JSON.stringify(encoded, null, 2))),
  );
