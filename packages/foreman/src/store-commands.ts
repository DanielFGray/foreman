import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Option, Schema } from "effect";
import { Records } from "./records.ts";
import { PublishedRow, publishedQueue } from "./published.ts";
import { queueOf } from "./host.ts";
import { Refused } from "./commands.ts";
import { place, type Placement } from "./pipeline.ts";
import { factsOf } from "./pipeline-facts.ts";
import { pipelineFor, pipelinesPath, readPipelines } from "./pipeline-file.ts";

/**
 * Reads of the task store that a client makes every few seconds.
 *
 * The panel and herdr-web show the queue and a task's record through these,
 * so neither speaks to the task store itself, and a store other than prog is
 * one `Records` implementation away. They read the store only: no roster, no
 * checkout gates, no `Dispatcher.read`, which takes seconds.
 */

const json = Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Emit JSON"));

const project = Flag.String("project").pipe(
  Flag.withDescription("One project; without it, every project an open space sits in"),
  Flag.optional,
);

/**
 * The queue in the order the fleet would dispatch it. `queueOf` is the read
 * herdr-web's server makes in process, so the two print the same rows.
 */
export const queueCommand = Command.make("queue", { json, project }, (args) =>
  Effect.gen(function* () {
    const { queue, epics } = yield* queueOf(args.project);
    if (args.json) {
      return yield* Console.log(
        JSON.stringify(
          yield* Schema.encodeEffect(Schema.Array(PublishedRow))(publishedQueue(queue, epics)),
        ),
      );
    }
    if (queue.length === 0) return yield* Console.log("queue empty");
    for (const task of queue) {
      yield* Console.log(`${task.id} [${task.project}] p${task.priority} ${task.title}`);
    }
  }),
).pipe(Command.withDescription("Print the ready queue in the order the fleet would dispatch it"));

const id = Argument.String("id").pipe(Argument.withDescription("A task id"));

/** The block placement puts the task at, named for a human reader. */
const stepOf = (placement: Placement): string | undefined =>
  placement._tag === "At"
    ? placement.node.id
    : placement._tag === "Parked"
      ? placement.node
      : undefined;

/** One task whole: its fields, what done means, its step, and its log. */
export const showCommand = Command.make("show", { id, json }, (args) =>
  Effect.gen(function* () {
    const task = yield* (yield* Records).detail(args.id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new Refused({ detail: `no task ${args.id}` })),
          onSome: Effect.succeed,
        }),
      ),
    );
    const drawings = yield* readPipelines(pipelinesPath());
    const { pipeline } = pipelineFor(drawings.value, task.project);
    const step = stepOf(place(pipeline, factsOf(task, pipeline)));
    if (args.json) {
      return yield* Console.log(JSON.stringify({ ...task, step }));
    }
    yield* Console.log(
      `${task.id} [${task.project}] ${task.status}${step === undefined ? "" : ` at ${step}`} p${task.priority} ${task.title}`,
    );
    if (task.labels.length > 0) yield* Console.log(task.labels.join(" "));
    if (task.description) yield* Console.log(`\n${task.description}`);
    if (task.definitionOfDone) yield* Console.log(`\nDone when: ${task.definitionOfDone}`);
    for (const log of task.logs)
      yield* Console.log(`\n${log.createdAt.toISOString()}  ${log.message}`);
  }),
).pipe(Command.withDescription("Print one task with its definition of done, its step and its log"));
