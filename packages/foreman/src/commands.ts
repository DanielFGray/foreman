import { Argument, Command, Flag } from "effect/cli";
import { Console, Duration, Effect, type Layer, Option, Schema, SubscriptionRef } from "effect";
import { ACTION_HELP, INTERVENTIONS, perform, rowFor, type Request } from "./actions.ts";
import { Dispatcher } from "./dispatcher.ts";
import { Fleet, untilNotWorking } from "./fleet.ts";
import { roundsOf } from "./lap.ts";
import { Prog } from "./prog.ts";
import { ACTIONS_LIST, actionsFor, rowsForView, VIEWS, type Action } from "./view.ts";
import { commandName, publishedOf } from "./published.ts";
import { Settings } from "./config.ts";

/**
 * The lifecycle as one-shot commands.
 *
 * Each command reads the world once, the way a tick begins, and then does one
 * thing a dashboard key or a tick would do. Nothing here holds state between
 * runs, so a command and the running dispatcher act on the same world without
 * coordinating: whatever one changes, the other reads back on its next look.
 * Pausing is `foreman policy`, because the pause lives in the policy file,
 * which every process reads.
 */

const id = Argument.String("id").pipe(
  Argument.withDescription("A task id, or the project, provider or branch a row is keyed by"),
);

const json = Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Emit JSON"));

/** Every row of every view, with the actions each one takes. */
const status = Command.make("status", { json }, ({ json }) =>
  Effect.gen(function* () {
    const dispatcher = yield* Dispatcher;
    yield* dispatcher.read;
    const published = publishedOf(yield* SubscriptionRef.get(dispatcher.state), Option.none());
    if (json) return yield* Console.log(JSON.stringify(published, null, 2));
    const rows = published.rows;
    if (rows.length === 0) return yield* Console.log("nothing queued, working or waiting");
    for (const row of rows) {
      yield* Console.log(
        `${row.view.padEnd(9)} ${row.key}  ${row.label}${row.actions.length > 0 ? `  [${row.actions.join(" ")}]` : ""}`,
      );
      if (row.detail) yield* Console.log(`${" ".repeat(10)}${row.detail}`);
    }
  }),
).pipe(
  Command.withDescription("List every row the dashboard would show, with the commands each takes"),
);

/** Runs one request against the row an id names, or says why it cannot. */
const act = (action: Action, key: string, request: Request) =>
  Effect.gen(function* () {
    const dispatcher = yield* Dispatcher;
    yield* dispatcher.read;
    const state = yield* SubscriptionRef.get(dispatcher.state);
    const row = rowFor(state, key, action);
    const command = row && perform(dispatcher, row, request);
    if (!command) {
      const offered = VIEWS.flatMap((view) =>
        rowsForView(view, state)
          .filter((candidate) => candidate.key === key)
          .map(
            (candidate) =>
              `${view}: ${actionsFor(candidate.column, candidate).map(commandName).join(" ") || "none"}`,
          ),
      );
      return yield* new Refused({
        detail:
          `${commandName(action)} does not apply to ${key}` +
          (offered.length === 0 ? ": no row has that key" : ` (it takes ${offered.join("; ")})`),
      });
    }
    yield* command;
    yield* Console.log(`${commandName(action)} ${key}: done`);
  });

const reason = Flag.String("reason").pipe(Flag.withDescription("What the task log says"));

const how = Flag.Literals("how", INTERVENTIONS).pipe(
  Flag.withDescription("Resume at a rung, or diagnose or review the last attempt"),
);

const rung = Flag.String("rung").pipe(Flag.withDescription("A ladder rung by name"), Flag.optional);

/**
 * One subcommand per dashboard action. The three that ask a question in the
 * dashboard take its answer as an option instead.
 */
const actionCommand = <E>(action: Action, services: Services<E>) => {
  const finish = <Input, ContextInput, CommandError, R>(
    command: Command.Command<string, Input, ContextInput, CommandError, R>,
  ) => Command.provide(Command.withDescription(command, ACTION_HELP[action]), services);
  switch (action) {
    case "complete":
      return finish(
        Command.make(commandName(action), { id, reason }, (args) =>
          act(action, args.id, { action, reason: args.reason }),
        ),
      );
    case "kill":
      return finish(
        Command.make(commandName(action), { id, reason: Flag.optional(reason) }, (args) =>
          act(action, args.id, { action, reason: args.reason }),
        ),
      );
    case "intervene":
      return finish(
        Command.make(commandName(action), { id, how, rung }, (args) =>
          act(action, args.id, { action, how: args.how, rung: Option.getOrUndefined(args.rung) }),
        ),
      );
    default:
      return finish(
        Command.make(commandName(action), { id }, (args) => act(action, args.id, { action })),
      );
  }
};

const dispatch = Command.make("dispatch", { id, rung }, (args) =>
  Effect.gen(function* () {
    const dispatcher = yield* Dispatcher;
    const named = Option.getOrUndefined(args.rung);
    if (named !== undefined && !dispatcher.rungs.includes(named)) {
      return yield* new Refused({
        detail: `no dispatchable rung ${named}; rungs: ${dispatcher.rungs.join(", ")}`,
      });
    }
    yield* dispatcher.read;
    const task = (yield* SubscriptionRef.get(dispatcher.state)).queue.find(
      (candidate) => candidate.id === args.id,
    );
    if (!task)
      return yield* new Refused({ detail: `${args.id} is not in the queue; see foreman queue` });
    yield* dispatcher.author(task, named);
    yield* Console.log(`${args.id}: dispatched; see foreman status, or foreman wait ${args.id}`);
  }),
).pipe(
  Command.withDescription(
    "Start a queued task's author now, on the rung a tick would choose or on --rung",
  ),
);

const role = Argument.Literals("role", ["author", "review"] as const);

const prompt = Command.make("prompt", { role, id }, (args) =>
  Effect.gen(function* () {
    const text = yield* (yield* Dispatcher).prompt(args.role, args.id);
    if (text === undefined) {
      return yield* new Refused({
        detail: `no ${args.role} prompt for ${args.id}: its project is not managed, or it has no branch to review`,
      });
    }
    yield* Console.log(text);
  }),
).pipe(Command.withDescription("Print the prompt foreman would send an author or reviewer"));

const text = Argument.String("text").pipe(Argument.withDescription("What the agent is told"));

const sayRole = Flag.Literals("role", ["author", "review"] as const).pipe(
  Flag.withDescription("Which of the task's agents to tell"),
  Flag.withDefault("author" as const),
);

/** The live worker of a task, or a refusal naming why there is none. */
const workerOf = (task: string) =>
  Effect.gen(function* () {
    const worker = (yield* (yield* Fleet).roster).find((candidate) => candidate.task === task);
    if (!worker) return yield* new Refused({ detail: `${task} has no workspace` });
    return worker;
  });

const say = Command.make("say", { id, role: sayRole, text }, (args) =>
  Effect.gen(function* () {
    yield* (yield* Fleet).say(yield* workerOf(args.id), args.role, args.text);
    yield* Console.log(`${args.id}: ${args.role} is working on it`);
  }),
).pipe(
  Command.withDescription(
    "Send a message to a task's live agent, returning once it is working on it",
  ),
);

/**
 * One correction round to the author, counted on the author's run.
 *
 * A review allows `MAX_ROUNDS`: an author that cannot act on clear mechanical
 * findings by then is telling the reviewer its rung is too low, and only a
 * returned task records that. So a further round is refused here rather than
 * asked of the reviewer in prose.
 */
const MAX_ROUNDS = 2;

const correct = Command.make("correct", { id, text }, (args) =>
  Effect.gen(function* () {
    const prog = yield* Prog;
    if (roundsOf(yield* prog.show(args.id)) >= MAX_ROUNDS) {
      return yield* new Refused({
        detail: `${args.id} already had ${MAX_ROUNDS} correction rounds; return the task with prog open instead`,
      });
    }
    yield* (yield* Fleet).say(yield* workerOf(args.id), "author", args.text);
    yield* prog.countRound(args.id);
    yield* Console.log(`${args.id}: round sent; run foreman wait ${args.id} --role author`);
  }),
).pipe(
  Command.withDescription(
    "Send the author one round of mechanical findings, and count it; two rounds at most",
  ),
);

const interval = Flag.Int("interval").pipe(
  Flag.withDescription("Seconds between readings, for --asks"),
  Flag.withDefault(10),
);

const waitRole = Flag.Literals("role", ["author", "review"] as const).pipe(
  Flag.withDescription("Wait for this agent only; a reviewer waiting on its author needs this"),
  Flag.optional,
);

/**
 * Blocks until the reading holds an ask that was not there when the wait
 * began, then prints it. A coordinator agent runs this in the background to
 * learn that the policy is holding a step for its approval.
 *
 * Each poll re-reads the world, so a step the operator has already approved
 * is gone from the next reading and cannot satisfy the wait.
 */
const waitForAsks = (interval: number) =>
  Effect.gen(function* () {
    const dispatcher = yield* Dispatcher;
    const reading = Effect.gen(function* () {
      yield* dispatcher.read;
      return (yield* SubscriptionRef.get(dispatcher.state)).asks;
    });
    const key = (ask: { readonly task: { readonly id: string }; readonly step: string }) =>
      `${ask.task.id} ${ask.step}`;
    const before = new Set((yield* reading).map(key));
    while (true) {
      yield* Effect.sleep(Duration.seconds(interval));
      const fresh = (yield* reading).filter((ask) => !before.has(key(ask)));
      if (fresh.length === 0) continue;
      for (const ask of fresh) {
        yield* Console.log(
          `${ask.task.id}: ${ask.step} waits for approval; foreman approve ${ask.task.id}`,
        );
      }
      return;
    }
  });

const asksFlag = Flag.Boolean("asks").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Wait for a step the policy is holding for approval to appear, instead of a task's agents",
  ),
);

const optionalId = Argument.String("id").pipe(
  Argument.withDescription("A task id; required unless --asks"),
  Argument.optional,
);

const wait = Command.make(
  "wait",
  { id: optionalId, interval, role: waitRole, asks: asksFlag },
  (args) =>
    Effect.gen(function* () {
      if (args.asks) {
        if (Option.isSome(args.id)) {
          return yield* new Refused({ detail: "--asks waits for any task, so it takes no id" });
        }
        return yield* waitForAsks(args.interval);
      }
      if (Option.isNone(args.id)) {
        return yield* new Refused({ detail: "wait needs a task id, or --asks" });
      }
      const taskId = args.id.value;
      const fleet = yield* Fleet;
      const prog = yield* Prog;
      const working = fleet.roster.pipe(
        Effect.map((roster) =>
          roster.some(
            (worker) =>
              worker.task === taskId &&
              Option.match(args.role, {
                onNone: () => worker.state === "working",
                onSome: (role) => worker.roles.get(role) === "working",
              }),
          ),
        ),
      );
      yield* untilNotWorking(working, fleet.awaitTurn(taskId, Option.getOrUndefined(args.role)));
      const task = yield* prog.show(taskId);
      yield* Console.log(`${taskId}: ${task.status}`);
    }),
).pipe(
  Command.withDescription(
    "Wait until a task's agents stop working, then print its status; --asks waits for a step to need approval",
  ),
);

/**
 * Every one-shot command, each given the services it reads. Provided per
 * command rather than around the whole program, so `foreman --skill` and the
 * commands that read only the store build none of this.
 */
export const subcommands = <E>(services: Services<E>) => [
  Command.provide(status, services),
  Command.provide(say, services),
  Command.provide(correct, services),
  Command.provide(dispatch, services),
  Command.provide(prompt, services),
  Command.provide(wait, services),
  ...ACTIONS_LIST.map((action) => actionCommand(action, services)),
];

/** A command that does not apply to what it was pointed at, and why. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/** What a one-shot command reads. */
type Services<E> = Layer.Layer<Dispatcher | Fleet | Prog | Settings, E>;
