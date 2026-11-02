import { Context, Effect, Layer, Option, Schema as S } from "effect";
import { Tasks, TaskError, type Item, type ListFilter, type LogEntry, type TaskEvent } from "tasks";

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
    /** Takes the task: after this it is no longer ready. */
    readonly claim: (task: string) => Effect.Effect<void, TrackerError>;
    /** Puts the task back among the ready work. */
    readonly reopen: (task: string) => Effect.Effect<void, TrackerError>;
    /** Puts the task in review from whatever status it was left in. */
    readonly submit: (task: string) => Effect.Effect<void, TrackerError>;
    /** Moves claimed work to review. */
    readonly review: (task: string) => Effect.Effect<void, TrackerError>;
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

    const move = (event: TaskEvent) => (task: string) =>
      tasks.send(task, event).pipe(as(`${event} ${task}`), Effect.asVoid);

    return Tracker.of({
      lookup: (task) => tasks.get(task).pipe(as(`show ${task}`)),
      list: (filter) => tasks.list(filter).pipe(as(`list ${JSON.stringify(filter)}`)),
      ready: (project) => tasks.ready(project).pipe(as("ready")),
      logs: (task) => tasks.logs(task).pipe(as(`show ${task}`)),
      add: (task) => tasks.add(task).pipe(as(`add ${task.title}`)),
      claim: move("start"),
      reopen: move("open"),
      submit: move("submit"),
      review: move("review"),
      complete: move("done"),
      label: (task, label) => tasks.label(task, label).pipe(as(`label ${task} ${label}`)),
      unlabel: (task, label) => tasks.unlabel(task, label).pipe(as(`unlabel ${task} ${label}`)),
      relabel: (task, change) => tasks.relabel(task, change).pipe(as(`relabel ${task}`)),
      log: (task, message) => tasks.log(task, message).pipe(as(`log ${task}`), Effect.asVoid),
    });
  }),
).pipe(Layer.provide(Tasks.layerSql));
