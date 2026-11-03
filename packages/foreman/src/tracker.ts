import { Context, Effect, FileSystem, Layer, Option, Schema as S } from "effect";
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
import { policyPath, readPolicy, trackerOf, type Policy, type TrackerName } from "./policy.ts";

/**
 * The task tracker foreman takes its work from, in tracker terms: which tasks
 * exist and in what status, their labels, their logs, and the status moves
 * foreman makes on them. Nothing here names a run, a rung or one of foreman's
 * own labels; those are foreman's records (`records.ts`), kept beside the
 * tracker's tasks and keyed by task id.
 *
 * `TasksTracker` below is the one adapter built: the `tasks` package's store.
 * `ProjectTracker` is the `Tracker` the rest of foreman sees: it sends each
 * call to the adapter of the task's project, as the policy file chooses it.
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
export const TasksTracker: Effect.Effect<Tracker["Service"], never, Tasks> = Effect.gen(
  function* () {
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
  },
);

/**
 * The `Tracker` foreman runs on: each call goes to the adapter of its
 * project's tracker, read from the policy file on each call that needs it, so
 * an operator's `foreman policy tracker` applies from the next call on.
 *
 * Built over the prog store's connection, which `Records.layer` shares, so
 * `together` stays atomic for prog projects.
 */
export const ProjectTracker = Layer.effect(
  Tracker,
  Effect.gen(function* () {
    const prog = yield* TasksTracker;
    const fs = yield* FileSystem.FileSystem;
    const choices = readPolicy(policyPath()).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.map(({ policy }) => policy),
    );
    return routeByProject({ prog, github: unbuilt("github"), linear: unbuilt("linear") }, choices);
  }),
).pipe(Layer.provide(Tasks.layerSql));

/**
 * Routes each call to `adapters[tracker of the call's project]`.
 *
 * A prog id carries no project, so an id without `<project>#` is prog's and
 * needs no policy read. An issue id `<project>#<n>` names its project. Calls
 * that take a project route by it; `list` by a parent routes by the parent's
 * id, because an epic's children live in the epic's tracker.
 *
 * A read across every project (`ready(undefined)`, `list` with no project or
 * parent) joins prog's rows of prog projects with each other project's own
 * read. A project whose read fails is left out of the join, so one tracker
 * that does not answer takes no step and does not stop the rest of the fleet.
 */
export const routeByProject = (
  adapters: Readonly<Record<TrackerName, Tracker["Service"]>>,
  choices: Effect.Effect<Policy>,
): Tracker["Service"] => {
  const forProject = (project: string) =>
    choices.pipe(Effect.map((policy) => adapters[trackerOf(policy, project)]));
  const forId = (id: string) => {
    const project = projectOfId(id);
    return project === undefined ? Effect.succeed(adapters.prog) : forProject(project);
  };
  const byId =
    <A extends ReadonlyArray<unknown>, R>(
      call: (
        tracker: Tracker["Service"],
        task: string,
        ...rest: A
      ) => Effect.Effect<R, TrackerError>,
    ) =>
    (task: string, ...rest: A) =>
      forId(task).pipe(Effect.flatMap((tracker) => call(tracker, task, ...rest)));

  /** prog's rows of prog projects, joined with each other project's own read. */
  const everywhere = (
    fromProg: Effect.Effect<ReadonlyArray<Item>, TrackerError>,
    fromProject: (
      tracker: Tracker["Service"],
      project: string,
    ) => Effect.Effect<ReadonlyArray<Item>, TrackerError>,
  ) =>
    Effect.gen(function* () {
      const policy = yield* choices;
      const elsewhere = Object.keys(policy.projects).filter(
        (project) => trackerOf(policy, project) !== "prog",
      );
      const own = (yield* fromProg).filter((item) => !elsewhere.includes(item.project));
      const others = yield* Effect.forEach(elsewhere, (project) =>
        fromProject(adapters[trackerOf(policy, project)], project).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`${project} left out: ${error.message}`).pipe(Effect.as([])),
          ),
        ),
      );
      return [...own, ...others.flat()];
    });

  return Tracker.of({
    lookup: byId((tracker, task) => tracker.lookup(task)),
    list: (filter) =>
      filter.project !== undefined
        ? forProject(filter.project).pipe(Effect.flatMap((tracker) => tracker.list(filter)))
        : filter.parent !== undefined
          ? forId(filter.parent).pipe(Effect.flatMap((tracker) => tracker.list(filter)))
          : everywhere(adapters.prog.list(filter), (tracker, project) =>
              tracker.list({ ...filter, project }),
            ),
    dependencies: (project) =>
      forProject(project).pipe(Effect.flatMap((tracker) => tracker.dependencies(project))),
    ready: (project) =>
      project !== undefined
        ? forProject(project).pipe(Effect.flatMap((tracker) => tracker.ready(project)))
        : everywhere(adapters.prog.ready(undefined), (tracker, each) => tracker.ready(each)),
    logs: byId((tracker, task) => tracker.logs(task)),
    add: (task) => forProject(task.project).pipe(Effect.flatMap((tracker) => tracker.add(task))),
    claim: byId((tracker, task) => tracker.claim(task)),
    reopen: byId((tracker, task) => tracker.reopen(task)),
    complete: byId((tracker, task) => tracker.complete(task)),
    label: byId((tracker, task, label: string) => tracker.label(task, label)),
    unlabel: byId((tracker, task, label: string) => tracker.unlabel(task, label)),
    relabel: byId(
      (tracker, task, change: (labels: ReadonlyArray<string>) => ReadonlyArray<string>) =>
        tracker.relabel(task, change),
    ),
    log: byId((tracker, task, message: string) => tracker.log(task, message)),
  });
};

/** The project an issue id `<project>#<n>` names; prog ids name none. */
const projectOfId = (id: string): string | undefined => {
  const hash = id.lastIndexOf("#");
  return hash > 0 ? id.slice(0, hash) : undefined;
};

/** A tracker whose adapter does not exist yet: every call fails and names it. */
const unbuilt = (name: TrackerName): Tracker["Service"] => {
  const fail = () =>
    Effect.fail(new TrackerError({ command: `${name} tracker`, detail: "adapter not built" }));
  return Tracker.of({
    lookup: fail,
    list: fail,
    dependencies: fail,
    ready: fail,
    logs: fail,
    add: fail,
    claim: fail,
    reopen: fail,
    complete: fail,
    label: fail,
    unlabel: fail,
    relabel: fail,
    log: fail,
  });
};
