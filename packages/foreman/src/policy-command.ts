import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Schema } from "effect";
import {
  grant,
  Policy,
  policyPath,
  readPolicy,
  STEPS,
  updatePolicy,
  type Policy as PolicyType,
} from "./policy.ts";

/**
 * `foreman policy`: read and change what the fleet may do by itself.
 *
 * Every subcommand writes through `updatePolicy` and prints the policy that
 * results, so the panel and a person at the shell change the file the same
 * way and see the same answer. The daemon reads the file on its next pass.
 */

const show = Command.make("show", {}, () =>
  Effect.gen(function* () {
    const read = yield* readPolicy(policyPath());
    if (read.error !== undefined) yield* Console.error(read.error);
    yield* print(read.policy);
  }),
).pipe(Command.withDescription("Print the policy the daemon reads"));

const change = (name: string, description: string, edit: (policy: PolicyType) => PolicyType) =>
  Command.make(name, {}, () => write(edit)).pipe(Command.withDescription(description));

const step = Argument.Literals("step", STEPS);
const setting = Argument.Literals("setting", ["on", "off"] as const);

const set = Command.make("set", { step, setting }, ({ step, setting }) =>
  write((policy) => ({
    ...policy,
    default: { ...policy.default, [step]: setting === "on" },
  })),
).pipe(Command.withDescription("Allow or stop one step for every task"));

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
    change("pause", "Stop every step, grants included, until resumed", (p) => ({
      ...p,
      paused: true,
    })),
    change("resume", "Undo pause; the default and the grants apply again", (p) => ({
      ...p,
      paused: false,
    })),
    set,
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
