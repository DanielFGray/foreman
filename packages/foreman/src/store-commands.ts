import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Option, Schema } from "effect";
import { prose } from "tasks";
import { Records } from "./records.ts";
import { Tracker } from "./tracker.ts";
import { PublishedRow, publishedQueue } from "./published.ts";
import { queueOf } from "./host.ts";
import { Refused } from "./commands.ts";
import { place, type Placement } from "./pipeline.ts";
import { factsOf } from "./pipeline-facts.ts";
import { pipelineFor, pipelinesPath, readPipelines } from "./pipeline-file.ts";

/**
 * Reads of the task store that a client makes every few seconds, and the
 * tracker commands an agent runs: show, log and list. Each goes through
 * `ProjectTracker`, so one prompt serves every tracker. `foreman add` is in
 * `commands.ts`, because it can also dispatch the task it files.
 *
 * The herdr-app pane shows the queue and a task's record through these, so
 * it never speaks to any tracker itself, and a tracker other than the local
 * tasks store is one `Records` implementation away. They read the store only:
 * no roster, no checkout gates, no `Dispatcher.read`, which takes seconds.
 */

const json = Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Emit JSON"));

const project = Flag.String("project").pipe(
  Flag.withDescription("One project; without it, every project an open space sits in"),
  Flag.optional,
);

/** The queue in the order the fleet would dispatch it. */
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
    : placement._tag === "Parked" || placement._tag === "ExitGone"
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

const message = Argument.String("message").pipe(
  Argument.withDescription("What to log, or - to read it from stdin"),
);

/**
 * Appends to a task's log in its project's tracker, which `ProjectTracker`
 * picks from the id. Agents log through this rather than the tracker's own
 * tool, so one prompt serves every tracker.
 */
export const logCommand = Command.make("log", { id, message }, (args) =>
  Effect.gen(function* () {
    const text = yield* prose(args.message);
    if (text.trim() === "") return yield* new Refused({ detail: "the message is empty" });
    yield* (yield* Tracker).log(args.id, text.trim());
  }),
).pipe(Command.withDescription("Append to a task's log in its project's tracker"));

const inProject = Flag.String("project").pipe(
  Flag.withAlias("p"),
  Flag.withDescription("The project, which picks its tracker"),
);

/**
 * Every task of one project in its tracker, any status: the backlog an agent
 * searches before it files a new task.
 */
export const listCommand = Command.make("list", { project: inProject, json }, (args) =>
  Effect.gen(function* () {
    const items = yield* (yield* Tracker).list({ project: args.project });
    if (args.json) return yield* Console.log(JSON.stringify(items));
    if (items.length === 0) return yield* Console.log(`no tasks in ${args.project}`);
    for (const item of items) {
      yield* Console.log(`${item.id} ${item.status} p${item.priority} ${item.title}`);
    }
  }),
).pipe(Command.withDescription("Print every task of a project from its tracker"));
