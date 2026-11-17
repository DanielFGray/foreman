/**
 * `foreman runs record <terminal>`: writes the run of an agent a person started
 * by hand, so it counts in the record the ladder is chosen from.
 *
 * The dispatcher writes its own runs. A hand-launched delegate has no row
 * unless someone writes one, and the terminal the agent runs in already says
 * which task it works, what harness and model it launched with, and when it
 * started. The flags say what the run produced.
 */
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Clock, Console, Effect, Option, Schema as S, Stream } from "effect";
import {
  AGENT_WORK,
  DEFECT_KINDS,
  DEFECTS,
  OUTCOMES,
  type DefectKind,
  type HandRunInput,
  type Item,
} from "tasks";
import { Refused } from "./errors.ts";
import { Records } from "./records.ts";
import { poolFor } from "./run-record.ts";
import { Tracker } from "./tracker.ts";

/** The fields of `hc get <terminal> --json` a hand run reads. */
export const HandTerminal = S.Struct({
  address: S.String,
  created_ms: S.Finite,
  labels: S.Record(S.String, S.String),
  foreground: S.optional(S.NullOr(S.Struct({ argv: S.Array(S.String) }))),
});
export type HandTerminal = typeof HandTerminal.Type;

/** The flags as the command line gave them, before any is checked. */
export interface RawFlags {
  readonly work: string;
  readonly outcome: string;
  readonly size: number;
  readonly rounds: number;
  readonly accurate: boolean;
  readonly inaccurate: boolean;
  readonly model: Option.Option<string>;
  readonly notes: Option.Option<string>;
  readonly defects: ReadonlyArray<string>;
}

/** The flags once each has been checked: the values the run row is written from. */
export interface CheckedFlags {
  readonly work: (typeof AGENT_WORK)[number];
  readonly outcome: (typeof OUTCOMES)[number];
  readonly size: number;
  readonly rounds: number;
  readonly accurate: boolean;
  readonly model: Option.Option<string>;
  readonly notes: Option.Option<string>;
  readonly defects: ReadonlyArray<{ readonly kind: DefectKind; readonly detail: string }>;
}

/** The value a flag took, if it is one of `allowed`; otherwise a refusal that lists the allowed values. */
export const oneOf = <const V extends string>(
  flag: string,
  value: string,
  allowed: ReadonlyArray<V>,
): Effect.Effect<V, Refused> => {
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined
    ? Effect.fail(
        new Refused({ detail: `--${flag} must be one of: ${allowed.join(", ")} (got "${value}")` }),
      )
    : Effect.succeed(found);
};

/** One `kind:detail` defect, with the kind checked against the defects table's list. */
const defectOf = (text: string) => {
  const colon = text.indexOf(":");
  const kind = colon < 0 ? text : text.slice(0, colon);
  const detail = colon < 0 ? "" : text.slice(colon + 1);
  return Effect.gen(function* () {
    const checked = yield* oneOf("defect", kind, DEFECT_KINDS);
    if (detail.trim() === "") {
      return yield* new Refused({
        detail: `--defect ${text} needs a detail after the kind: kind:detail`,
      });
    }
    return { kind: checked, detail };
  });
};

/**
 * Every flag checked before the terminal is read or anything is written, so a
 * wrong value costs nothing but its refusal.
 */
export const checkFlags = (flags: RawFlags): Effect.Effect<CheckedFlags, Refused> =>
  Effect.gen(function* () {
    if (flags.accurate === flags.inaccurate) {
      return yield* new Refused({ detail: "give exactly one of --accurate or --inaccurate" });
    }
    if (flags.size < 1) {
      return yield* new Refused({ detail: `--size must be at least 1 (got ${flags.size})` });
    }
    if (flags.rounds < 0) {
      return yield* new Refused({ detail: `--rounds cannot be negative (got ${flags.rounds})` });
    }
    const work = yield* oneOf("work", flags.work, AGENT_WORK);
    const outcome = yield* oneOf("outcome", flags.outcome, OUTCOMES);
    const defects = yield* Effect.all(flags.defects.map(defectOf));
    return {
      work,
      outcome,
      size: flags.size,
      rounds: flags.rounds,
      accurate: flags.accurate,
      model: flags.model,
      notes: flags.notes,
      defects,
    };
  });

/**
 * The run a terminal's agent made. The harness is the basename of the launch
 * argv's program; the model is the value after `--model` in that argv, or the
 * `--model` flag when the argv names none; the pool is the model's provider
 * prefix, as `newRunFor` writes it. The task's project and title are the row's.
 */
export const handRunFor = (input: {
  readonly terminal: HandTerminal;
  readonly task: Pick<Item, "id" | "project" | "title">;
  readonly flags: CheckedFlags;
  readonly closedAt: Date;
}): Effect.Effect<HandRunInput, Refused> =>
  Effect.gen(function* () {
    const { terminal, task, flags } = input;
    const argv = terminal.foreground?.argv ?? [];
    const program = yield* Effect.fromOption(Option.fromNullishOr(argv[0])).pipe(
      Effect.mapError(
        () =>
          new Refused({
            detail: `terminal ${terminal.address} runs no program; start its agent first`,
          }),
      ),
    );
    const kind = program.split("/").at(-1) ?? program;
    const at = argv.indexOf("--model");
    const named = at < 0 ? Option.none<string>() : Option.fromNullishOr(argv[at + 1]);
    const model = yield* Effect.fromOption(Option.orElse(named, () => flags.model)).pipe(
      Effect.mapError(
        () =>
          new Refused({
            detail: `no --model in the launch argv of ${terminal.address}; pass --model <provider/model>`,
          }),
      ),
    );
    const [provider, ...rest] = model.split("/");
    return {
      project: task.project,
      task: task.id,
      slice: task.title,
      kind,
      pool: rest.length > 0 && provider !== undefined ? poolFor(provider) : kind,
      model,
      work: flags.work,
      outcome: flags.outcome,
      startedAt: new Date(terminal.created_ms),
      closedAt: input.closedAt,
      rounds: flags.rounds,
      size: flags.size,
      reportAccurate: flags.accurate,
      notes: Option.getOrUndefined(flags.notes),
      defects: flags.defects,
    };
  });

/** Runs `hc get <address> --json` and decodes the terminal it prints. */
const readTerminal = (address: string) =>
  Effect.gen(function* () {
    const { exitCode, stdout, stderr } = yield* Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const process = yield* spawner.spawn(ChildProcess.make("hc", ["get", address, "--json"]));
        const [code, out, err] = yield* Effect.all(
          [
            process.exitCode,
            Stream.decodeText(process.stdout).pipe(Stream.mkString),
            Stream.decodeText(process.stderr).pipe(Stream.mkString),
          ],
          { concurrency: 3 },
        );
        return { exitCode: Number(code), stdout: out, stderr: err };
      }),
    ).pipe(
      Effect.mapError(
        (cause) => new Refused({ detail: `could not run hc get ${address}: ${String(cause)}` }),
      ),
    );
    if (exitCode !== 0) {
      return yield* new Refused({
        detail: `hc get ${address} exited ${exitCode}: ${stderr.trim()}`,
      });
    }
    return yield* S.decodeEffect(S.fromJsonString(HandTerminal))(stdout).pipe(
      Effect.mapError(() => new Refused({ detail: `hc get ${address} did not print a terminal` })),
    );
  });

/** The task the terminal's `fm.task` label names, which the tracker must hold. */
const taskOf = (terminal: HandTerminal) =>
  Effect.gen(function* () {
    const id = terminal.labels["fm.task"];
    if (id === undefined) {
      return yield* new Refused({
        detail: `terminal ${terminal.address} has no fm.task label; set it with hc label ${terminal.address} fm.task=<id>`,
      });
    }
    const tracker = yield* Tracker;
    return yield* Effect.fromOption(yield* tracker.lookup(id)).pipe(
      Effect.mapError(() => new Refused({ detail: `no task ${id} in the store` })),
    );
  });

const terminal = Argument.String("terminal").pipe(
  Argument.withDescription("The hc terminal the agent ran in, such as t7 or a name"),
);

const work = Flag.String("work").pipe(
  Flag.withDescription(`The work the run did: ${AGENT_WORK.join(", ")}`),
);

const outcome = Flag.String("outcome").pipe(
  Flag.withDescription(`How the run closed: ${OUTCOMES.join(", ")}`),
);

const size = Flag.Int("size").pipe(
  Flag.withDescription("The slice's size: 1 one file or rule, 2 one package, 3 crosses packages"),
);

const rounds = Flag.Int("rounds").pipe(Flag.withDescription("Correction rounds the task took"));

const accurate = Flag.Boolean("accurate").pipe(
  Flag.withDefault(false),
  Flag.withDescription("The author's report matched the diff or the cited code"),
);

const inaccurate = Flag.Boolean("inaccurate").pipe(
  Flag.withDefault(false),
  Flag.withDescription("The author's report did not match the diff or the cited code"),
);

const model = Flag.String("model").pipe(
  Flag.withDescription("The model, when the launch argv names none: provider/model"),
  Flag.optional,
);

const notes = Flag.String("notes").pipe(
  Flag.withDescription("What the run's evidence shows, in words"),
  Flag.optional,
);

const defect = Flag.String("defect").pipe(
  Flag.withDescription(
    `A defect a review found, as kind:detail; repeat for each. Kinds: ${DEFECTS.map((d) => `${d.kind} (${d.meaning})`).join("; ")}`,
  ),
  Flag.atLeast(0),
);

/** `foreman runs record`: every flag is checked before the terminal is read or a row is written. */
export const recordCommand = Command.make(
  "record",
  { terminal, work, outcome, size, rounds, accurate, inaccurate, model, notes, defect },
  (args) =>
    Effect.gen(function* () {
      const flags = yield* checkFlags({
        work: args.work,
        outcome: args.outcome,
        size: args.size,
        rounds: args.rounds,
        accurate: args.accurate,
        inaccurate: args.inaccurate,
        model: args.model,
        notes: args.notes,
        defects: args.defect,
      });
      const hand = yield* readTerminal(args.terminal);
      const task = yield* taskOf(hand);
      const run = yield* handRunFor({
        terminal: hand,
        task,
        flags,
        closedAt: new Date(yield* Clock.currentTimeMillis),
      });
      const records = yield* Records;
      const id = yield* records.recordHandRun(run);
      yield* Console.log(
        `recorded run ${id} of ${task.id} (${task.project}): ${run.work}, ${run.outcome}`,
      );
    }),
).pipe(
  Command.withDescription(
    "Record the run of an agent started by hand, from its hc terminal: task from fm.task, harness and model from its launch argv",
  ),
);
