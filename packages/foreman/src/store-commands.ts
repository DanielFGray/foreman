import { Argument, Command, Flag } from "effect/cli";
import { Clock, Console, DateTime, Effect, Option, Schema } from "effect";
import { durationOf, type Item, prose, RunRecord } from "tasks";
import { notesLines, RunSummary, summarizeRuns } from "./run-summary.ts";
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

/** An item as JSON readers know it: `parent` and `definitionOfDone` are strings, absent when none. */
const plainOptions = <A extends Item>(item: A) => ({
  ...item,
  parent: Option.getOrUndefined(item.parent),
  definitionOfDone: Option.getOrUndefined(item.definitionOfDone),
});

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

const MINUTES = (minutes: number) => minutes.toFixed(1);

/** A run's start in local time, to the minute. */
const startedLabel = (at: Date) =>
  DateTime.formatLocal(DateTime.makeUnsafe(at), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** The run's minutes column: an open run says so, even without a start, since that is the state a reader needs. */
const minutesOf = (run: RunRecord): string => {
  if (Option.isNone(run.closedAt)) return "open";
  return Option.match(durationOf(run), {
    onNone: () => "-",
    onSome: (ms) => MINUTES(ms / 60_000),
  });
};

/** The run table: one row per run, oldest first, columns aligned to the widest cell. */
const runTable = (runs: ReadonlyArray<RunRecord>): ReadonlyArray<string> => {
  const rows = runs.map((run) => [
    String(run.id),
    run.work,
    Option.getOrElse(run.rung, () => Option.getOrElse(run.model, () => "-")),
    Option.getOrElse(run.node, () => "-"),
    Option.match(run.startedAt, { onNone: () => "-", onSome: startedLabel }),
    minutesOf(run),
    Option.getOrElse(run.ending, () => "-"),
    Option.match(run.rounds, { onNone: () => "-", onSome: String }),
  ]);
  const header = ["id", "work", "rung", "node", "started", "minutes", "ending", "rounds"];
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  return [header, ...rows].map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  );
};

/** The summary line under the run table; the elapsed part is left out when no run has a start. */
const summaryLine = (summary: RunSummary): string => {
  const parts = [
    Option.match(summary.elapsedMinutes, {
      onNone: () => undefined,
      onSome: (minutes) => `elapsed ${MINUTES(minutes)} min`,
    }),
    `agent ${Option.match(summary.agentMinutes, { onNone: () => "-", onSome: (m) => `${MINUTES(m)} min` })}`,
    `author runs ${summary.authorRuns}`,
    `returned ${summary.returned}`,
    `rounds ${Option.match(summary.rounds, { onNone: () => "-", onSome: String })}`,
  ];
  return parts.filter((part) => part !== undefined).join(" · ");
};

/** One task whole: its fields, what done means, its step, its runs and its log. */
export const showCommand = Command.make("show", { id, json }, (args) =>
  Effect.gen(function* () {
    const records = yield* Records;
    const task = yield* records.detail(args.id).pipe(
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
    const history = yield* records.history(task.id);
    const now = new Date(yield* Clock.currentTimeMillis);
    const summary = summarizeRuns(history, task.status, now);
    if (args.json) {
      return yield* Console.log(
        JSON.stringify({
          ...plainOptions(task),
          step,
          history: yield* Schema.encodeEffect(Schema.Array(RunRecord))(history),
          summary: yield* Schema.encodeEffect(RunSummary)(summary),
        }),
      );
    }
    yield* Console.log(
      `${task.id} [${task.project}] ${task.status}${step === undefined ? "" : ` at ${step}`} p${task.priority} ${task.title}`,
    );
    if (task.labels.length > 0) yield* Console.log(task.labels.join(" "));
    if (task.description) yield* Console.log(`\n${task.description}`);
    const done = Option.getOrUndefined(task.definitionOfDone);
    if (done) yield* Console.log(`\nDone when: ${done}`);
    if (history.length > 0) {
      yield* Console.log("");
      for (const line of runTable(history)) yield* Console.log(line);
      yield* Console.log(summaryLine(summary));
      const notes = notesLines(history);
      if (notes.length > 0) yield* Console.log("");
      for (const line of notes) yield* Console.log(line);
    }
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

const since = Flag.String("since").pipe(
  Flag.withDescription("Only the runs that closed at or after this ISO instant"),
  Flag.optional,
);

const work = Flag.String("work").pipe(
  Flag.withDescription("Only the runs of this work: author, review or research"),
  Flag.optional,
);

const notes = Flag.Boolean("notes").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Keep only the runs that carry notes"),
);

/**
 * Every task of one project in its tracker, any status: the backlog an agent
 * searches before it files a new task.
 */
export const listCommand = Command.make("list", { project: inProject, json }, (args) =>
  Effect.gen(function* () {
    const items = yield* (yield* Tracker).list({ project: args.project });
    if (args.json) return yield* Console.log(JSON.stringify(items.map(plainOptions)));
    if (items.length === 0) return yield* Console.log(`no tasks in ${args.project}`);
    for (const item of items) {
      yield* Console.log(`${item.id} ${item.status} p${item.priority} ${item.title}`);
    }
  }),
).pipe(Command.withDescription("Print every task of a project from its tracker"));

/**
 * The closed runs of one project, oldest first, with the notes an agent left.
 * A run is a fact the world recorded, not a memory: the store holds it, so a
 * read spends nothing and writes nothing.
 */
export const runsCommand = Command.make(
  "runs",
  { project: inProject, since, work, notes, json },
  (args) =>
    Effect.gen(function* () {
      const records = yield* Records;
      const tasks = yield* (yield* Tracker).list({ project: args.project });
      const titles = new Map(tasks.map((task) => [task.id, task.title] as const));
      const after = Option.getOrElse(args.since, () => "1970-01-01T00:00:00.000Z");
      const onlyWork = Option.getOrUndefined(args.work);
      const closed = (yield* records.closedSince(new Date(after)))
        .filter((run) => run.project === args.project)
        .filter((run) => onlyWork === undefined || run.work === onlyWork)
        .filter((run) => !args.notes || Option.isSome(run.notes));
      if (args.json) {
        return yield* Console.log(
          JSON.stringify(yield* Schema.encodeEffect(Schema.Array(RunRecord))(closed)),
        );
      }
      for (const run of closed) {
        const lines = [
          `${run.id}  ${run.task} ${titles.get(run.task) ?? run.task}  ${run.work}  rung ${Option.getOrElse(run.rung, () => "-")}  ending ${Option.getOrElse(run.ending, () => "-")}  closed ${Option.match(run.closedAt, { onNone: () => "open", onSome: (at) => at.toISOString() })}`,
        ];
        const noteLines = Option.match(run.notes, {
          onNone: (): ReadonlyArray<string> => [],
          onSome: (text) => text.split("\n"),
        });
        const rows =
          noteLines.length === 0 ? lines : [...lines, ...noteLines.map((note) => `  ${note}`)];
        for (const line of rows) yield* Console.log(line);
      }
    }),
).pipe(Command.withDescription("Print a project's closed runs, oldest first"));
