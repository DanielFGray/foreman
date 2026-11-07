import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Option, Schema } from "effect";
import {
  CLOSED_PULL_REQUESTS,
  clearProject,
  grant,
  pauseProject,
  PULL_REQUEST_REVIEWS,
  setPullRequest,
  setProjectStep,
  setProjectTracker,
  Policy,
  STEP_MODES,
  STEPS,
  TRACKERS,
  type Policy as PolicyType,
  type Step,
  type StepMode,
} from "./policy.ts";
import { policyPath, readPolicy, updatePolicy } from "./policy-file.ts";
import { Linear } from "./linear.ts";
import { checkPlace } from "./linear-tracker.ts";
import { TrackerError } from "./tracker.ts";

/**
 * `foreman policy`: read and change what the fleet may do by itself.
 *
 * Every subcommand writes through `updatePolicy` and prints the policy that
 * results, so the Foreman pane and a person at the shell change the file the
 * same way and see the same answer. The dispatcher reads the file on its next
 * tick. The pane's verbs (set, grant, revoke, slots, pause, resume) are
 * exported Effects the CLI and the coming UI contract both call.
 */

/** Set one step's mode for the fleet, or for one project when `project` is set. */
export const policySet = (input: {
  readonly step: Step;
  readonly setting: StepMode;
  readonly project: string | undefined;
}) =>
  updatePolicy(policyPath(), (policy) =>
    input.project === undefined
      ? { ...policy, default: { ...policy.default, [input.step]: input.setting } }
      : setProjectStep(policy, input.project, input.step, input.setting),
  );

/** Stop every step until resumed; with `project`, stop that project only. */
export const policyPause = (input: { readonly project: string | undefined }) =>
  updatePolicy(policyPath(), (policy) =>
    input.project === undefined
      ? { ...policy, paused: true }
      : pauseProject(policy, input.project, true),
  );

/** Undo pause; with `project`, resume that project only. */
export const policyResume = (input: { readonly project: string | undefined }) =>
  updatePolicy(policyPath(), (policy) =>
    input.project === undefined
      ? { ...policy, paused: false }
      : pauseProject(policy, input.project, false),
  );

/** Set how many agents may work at once. */
export const policySlots = (input: { readonly count: number }) =>
  updatePolicy(policyPath(), (policy) => ({ ...policy, slots: input.count }));

/** Allow steps for one task or epic beyond the default. */
export const policyGrant = (input: {
  readonly scope: string;
  readonly steps: ReadonlyArray<Step>;
  readonly remaining: number | undefined;
}) =>
  updatePolicy(policyPath(), (policy) => grant(policy, input.scope, input.steps, input.remaining));

/** Remove the grant on a task or epic. */
export const policyRevoke = (input: { readonly scope: string }) =>
  updatePolicy(policyPath(), (policy) => ({
    ...policy,
    grants: policy.grants.filter((g) => g.scope !== input.scope),
  }));

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
  const verb = name === "pause" ? policyPause : policyResume;
  return Command.make(name, { project: projectFlag }, ({ project }) =>
    verb({ project: projectOf(project) }).pipe(Effect.flatMap(print)),
  ).pipe(
    Command.withDescription(
      name === "pause"
        ? "Stop every step, grants included, until resumed; with --project, stop that project only"
        : "Undo pause; the default and the grants apply again; with --project, resume that project only",
    ),
  );
};

const step = Argument.Literals("step", STEPS);
const setting = Argument.Literals("setting", STEP_MODES);

const set = Command.make("set", { step, setting, project: projectFlag }, (args) =>
  policySet({
    step: args.step,
    setting: args.setting,
    project: projectOf(args.project),
  }).pipe(Effect.flatMap(print)),
).pipe(
  Command.withDescription(
    "Set one step for every task, or one project's tasks with --project: on runs it, ask waits for one approval per task, off does nothing",
  ),
);

const clear = Command.make("clear", { project: Flag.String("project") }, ({ project }) =>
  write((policy) => clearProject(policy, project)),
).pipe(
  Command.withDescription(
    "Drop a project's step and pause settings, so it follows the default again; its tracker and pull-request settings stay",
  ),
);

const tracker = Command.make(
  "tracker",
  {
    tracker: Argument.Literals("tracker", TRACKERS).pipe(
      Argument.withDescription(
        "tasks (the local store; the default), github (the issues of the project's GitHub repo) or linear (a Linear project of a Linear team)",
      ),
    ),
    project: Flag.String("project"),
    team: Flag.String("team").pipe(
      Flag.withDescription("The Linear team key, for example ENG; needed with linear"),
      Flag.optional,
    ),
    linearProject: Flag.String("linear-project").pipe(
      Flag.withDescription("The Linear project name; needed with linear"),
      Flag.optional,
    ),
  },
  (args) =>
    Effect.gen(function* () {
      if (args.tracker !== "linear")
        return yield* write((policy) => setProjectTracker(policy, args.project, args.tracker));
      if (Option.isNone(args.team) || Option.isNone(args.linearProject))
        return yield* new TrackerError({
          command: "policy tracker linear",
          detail: "a Linear project needs --team <key> and --linear-project <name>",
        });
      const place = { team: args.team.value, project: args.linearProject.value };
      yield* checkPlace(place).pipe(Effect.provide(Linear.layer));
      return yield* write((policy) => setProjectTracker(policy, args.project, "linear", place));
    }),
).pipe(
  Command.withDescription(
    "Choose where a project's tasks live: tasks (the default), a GitHub repo's issues, or a Linear project of a Linear team, checked against Linear",
  ),
);

const pullRequest = Command.make(
  "pull-request",
  {
    project: Flag.String("project"),
    review: Flag.Literals("review", PULL_REQUEST_REVIEWS).pipe(
      Flag.withDescription(
        "comment posts the verdict as a comment review; approve posts a real approval with a second credential",
      ),
      Flag.optional,
    ),
    tokenEnv: Flag.String("token-env").pipe(
      Flag.withDescription(
        "The environment variable that holds the token an approving review runs with",
      ),
      Flag.optional,
    ),
    closed: Flag.Literals("closed", CLOSED_PULL_REQUESTS).pipe(
      Flag.withDescription("What a pull request closed without a merge does to its task"),
      Flag.optional,
    ),
  },
  (args) =>
    write((policy) =>
      setPullRequest(policy, args.project, {
        ...Option.match(args.review, { onNone: () => ({}), onSome: (review) => ({ review }) }),
        ...Option.match(args.tokenEnv, {
          onNone: () => ({}),
          onSome: (reviewTokenEnv) => ({ reviewTokenEnv }),
        }),
        ...Option.match(args.closed, { onNone: () => ({}), onSome: (closed) => ({ closed }) }),
      }),
    ),
).pipe(
  Command.withDescription(
    "Set how a project's pull-request landings post their review and treat a PR closed without a merge",
  ),
);

const count = Argument.Int("count").pipe(
  Argument.withSchema(Schema.Int.check(Schema.isGreaterThan(0))),
);

const slots = Command.make("slots", { count }, ({ count }) =>
  policySlots({ count }).pipe(Effect.flatMap(print)),
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
    policyGrant({
      scope: args.scope,
      steps: args.steps,
      remaining: Option.getOrUndefined(args.remaining),
    }).pipe(Effect.flatMap(print)),
).pipe(
  Command.withDescription(
    "Allow steps for one task or epic beyond the default; `grant ts-1 land --count 1` lands one approved task",
  ),
);

const revoke = Command.make("revoke", { scope }, ({ scope }) =>
  policyRevoke({ scope }).pipe(Effect.flatMap(print)),
).pipe(Command.withDescription("Remove the grant on a task or epic"));

export const policyCommand = Command.make("policy", {}).pipe(
  Command.withDescription(`Read and change what the fleet may do by itself (${policyPath()})`),
  Command.withSubcommands([
    show,
    pauseOrResume("pause"),
    pauseOrResume("resume"),
    pullRequest,
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
