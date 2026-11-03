import { Context, Effect, Layer, Option, Schema as S } from "effect";
import {
  Tasks,
  TaskError,
  type Dependency,
  type Item,
  type ListFilter,
  type LogEntry,
  type Status,
  type TaskEvent,
} from "tasks";

/**
 * The task tracker foreman takes its work from, in tracker terms: which tasks
 * exist and in what status, their labels, their logs, and the status moves
 * foreman makes on them. Nothing here names a run, a rung or one of foreman's
 * own labels; those are foreman's records (`records.ts`), kept beside the
 * tracker's tasks and keyed by task id.
 *
 * `TasksTracker` below is the one adapter: the `tasks` package's store.
 */
export class Tracker extends Context.Service<
  Tracker,
  {
    /** One task, or nothing when the tracker has no such task. */
    readonly lookup: (task: string) => Effect.Effect<Option.Option<Item>, TrackerError>;
    readonly list: (filter: ListFilter) => Effect.Effect<ReadonlyArray<Item>, TrackerError>;
    /** Every dependency edge from an item of `project`, whatever the status of either end. */
    readonly dependencies: (
      project: string,
    ) => Effect.Effect<ReadonlyArray<Dependency>, TrackerError>;
    /** Unblocked, unclaimed tasks, in every project or in one. */
    readonly ready: (
      project: string | undefined,
    ) => Effect.Effect<ReadonlyArray<Item>, TrackerError>;
    readonly logs: (task: string) => Effect.Effect<ReadonlyArray<LogEntry>, TrackerError>;
    /** Creates a task and answers its id. */
    readonly add: (task: {
      readonly project: string;
      readonly title: string;
      readonly description: string;
      readonly labels: ReadonlyArray<string>;
    }) => Effect.Effect<string, TrackerError>;
    /**
     * The status moves. Each skips a task that already has the status it
     * leads to, so a caller need not check the status first.
     *
     * Takes the task: after this it is no longer ready. Open, done and
     * canceled work may all be claimed — done or canceled when an unread
     * branch on them needs a reader.
     */
    readonly claim: (task: string) => Effect.Effect<void, TrackerError>;
    /** Puts the task back among the ready work. */
    readonly reopen: (task: string) => Effect.Effect<void, TrackerError>;
    readonly complete: (task: string) => Effect.Effect<void, TrackerError>;
    readonly label: (task: string, label: string) => Effect.Effect<void, TrackerError>;
    readonly unlabel: (task: string, label: string) => Effect.Effect<void, TrackerError>;
    /** Rewrites the task's labels in one write, answering the ones it carried before. */
    readonly relabel: (
      task: string,
      change: (labels: ReadonlyArray<string>) => ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, TrackerError>;
    /** Appends to the task's log. Also counts as activity. */
    readonly log: (task: string, message: string) => Effect.Effect<void, TrackerError>;
  }
>()("Tracker") {}

export class TrackerError extends S.TaggedError<TrackerError>()("TrackerError", {
  command: S.String,
  detail: S.String,
}) {
  override get message() {
    return `${this.command}: ${this.detail}`;
  }
}

/**
 * The `tasks` package's store as the tracker.
 *
 * Its writes run on the store's SQL connection, the one foreman's records use,
 * so a records write and a status move inside one `withTransaction` on that
 * connection commit or roll back together.
 */
export const TasksTracker = Layer.effect(
  Tracker,
  Effect.gen(function* () {
    const tasks = yield* Tasks;

    /** Runs a store call, naming the operation in its failure. */
    const as =
      (command: string) =>
      <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, TrackerError> =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new TrackerError({
                command,
                detail: cause instanceof TaskError ? cause.detail : String(cause),
              }),
          ),
        );

    /**
     * Sends a status event, skipping it when the task already has the status
     * the event leads to: claiming claimed work or reopening open work changes
     * nothing, and the store would refuse it as a move from a status to itself.
     */
    const move = (event: TaskEvent, to: Status) => (task: string) =>
      tasks.get(task).pipe(
        Effect.flatMap((item) =>
          Option.isSome(item) && item.value.status === to
            ? Effect.void
            : tasks.send(task, event).pipe(Effect.asVoid),
        ),
        as(`${event} ${task}`),
      );

    return Tracker.of({
      lookup: (task) => tasks.get(task).pipe(as(`show ${task}`)),
      list: (filter) => tasks.list(filter).pipe(as(`list ${JSON.stringify(filter)}`)),
      dependencies: (project) =>
        tasks.allDependencies(project).pipe(as(`dependencies of ${project}`)),
      ready: (project) => tasks.ready(project).pipe(as("ready")),
      logs: (task) => tasks.logs(task).pipe(as(`show ${task}`)),
      add: (task) => tasks.add(task).pipe(as(`add ${task.title}`)),
      claim: move("start", "in_progress"),
      reopen: move("open", "open"),
      complete: move("done", "done"),
      label: (task, label) => tasks.label(task, label).pipe(as(`label ${task} ${label}`)),
      unlabel: (task, label) => tasks.unlabel(task, label).pipe(as(`unlabel ${task} ${label}`)),
      relabel: (task, change) => tasks.relabel(task, change).pipe(as(`relabel ${task}`)),
      log: (task, message) => tasks.log(task, message).pipe(as(`log ${task}`), Effect.asVoid),
    });
  }),
).pipe(Layer.provide(Tasks.layerSql));
