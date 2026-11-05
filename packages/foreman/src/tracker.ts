import { Context, Effect, FileSystem, Layer, Option, Schema as S } from "effect";
import {
  Tasks,
  TaskError,
  type Dependency,
  type Item,
  type ListFilterInput,
  type LogEntry,
  type Status,
  type TaskEvent,
} from "tasks";
import { Fleet } from "./fleet.ts";
import { HcFleet } from "./hc.ts";
import { checkoutRepo, githubTracker } from "./github-tracker.ts";
import { Github } from "./github.ts";
import { Linear } from "./linear.ts";
import { linearTracker } from "./linear-tracker.ts";
import { Repository } from "./repository.ts";
import { policyPath, readPolicy, trackerOf, type Policy, type TrackerName } from "./policy.ts";

/**
 * The task tracker foreman takes its work from, in tracker terms: which tasks
 * exist and in what status, their labels, their logs, and the status moves
 * foreman makes on them. Nothing here names a run, a rung or one of foreman's
 * own labels; those are foreman's records (`records.ts`), kept beside the
 * tracker's tasks and keyed by task id.
 *
 * `TasksTracker` below is the `tasks` package's store; `githubTracker` in
 * `github-tracker.ts` is GitHub issues over `gh`; `linearTracker` in
 * `linear-tracker.ts` is Linear issues over its GraphQL API.
 * `ProjectTracker` is the `Tracker` the rest of foreman sees: it sends each
 * call to the adapter of the task's project, as the policy file chooses it.
 */
export class Tracker extends Context.Service<
  Tracker,
  {
    /**
     * Reads `project` anew. The reads after it answer from what it read until
     * the next refresh or a write in the project, so the dispatcher calls it
     * once at the start of each reading of the world. Its failure says the
     * tracker did not answer: the dispatcher then takes no step in the project.
     * A tracker that reads its store on every call has nothing to refresh.
     */
    readonly refresh: (project: string) => Effect.Effect<void, TrackerError>;
    /** One task, or nothing when the tracker has no such task. */
    readonly lookup: (task: string) => Effect.Effect<Option.Option<Item>, TrackerError>;
    readonly list: (filter: ListFilterInput) => Effect.Effect<ReadonlyArray<Item>, TrackerError>;
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
     *
     * Answers only once a read of the task shows the claim, because a tracker
     * whose reads lag its writes would otherwise show the task as ready to
     * the next dispatch, which starts a second worker on it. An adapter whose
     * reads can lag re-reads until the claim shows, and fails with a
     * `TrackerError` after 30 seconds; the claim then stays, and the release
     * of stale claims reopens it. `TasksTracker` writes in one SQL
     * transaction on the connection it reads from, so its write is its read.
     */
    readonly claim: (task: string) => Effect.Effect<void, TrackerError>;
    /** Puts the task back among the ready work. */
    readonly reopen: (task: string) => Effect.Effect<void, TrackerError>;
    readonly complete: (task: string) => Effect.Effect<void, TrackerError>;
    /** Closes the task as not to be done: `canceled` in tasks, closed as not planned on GitHub. */
    readonly cancel: (task: string) => Effect.Effect<void, TrackerError>;
    readonly label: (task: string, label: string) => Effect.Effect<void, TrackerError>;
    readonly unlabel: (task: string, label: string) => Effect.Effect<void, TrackerError>;
    /** Rewrites the task's labels in one write, answering the ones it carried before. */
    readonly relabel: (
      task: string,
      change: (labels: ReadonlyArray<string>) => ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, TrackerError>;
    /** Appends to the task's log. Also counts as activity. */
    readonly log: (task: string, message: string) => Effect.Effect<void, TrackerError>;
    /** The web page of the task in its tracker, or nothing when the tracker has none. */
    readonly url: (task: string) => Effect.Effect<Option.Option<string>, TrackerError>;
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
      refresh: () => Effect.void,
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
      cancel: move("cancel", "canceled"),
      label: (task, label) => tasks.label(task, label).pipe(as(`label ${task} ${label}`)),
      unlabel: (task, label) => tasks.unlabel(task, label).pipe(as(`unlabel ${task} ${label}`)),
      relabel: (task, change) => tasks.relabel(task, change).pipe(as(`relabel ${task}`)),
      log: (task, message) => tasks.log(task, message).pipe(as(`log ${task}`), Effect.asVoid),
      url: () => Effect.succeedNone,
    });
  },
);

/**
 * The `Tracker` foreman runs on: each call goes to the adapter of its
 * project's tracker, read from the policy file on each call that needs it, so
 * an operator's `foreman policy tracker` applies from the next call on.
 *
 * Built over the tasks store's connection, which `Records.layer` shares, so
 * `together` stays atomic for tasks projects. A GitHub project's repo is read
 * from its checkout, found among the open spaces and the running workers.
 */
export const ProjectTracker = Layer.effect(
  Tracker,
  Effect.gen(function* () {
    const tasks = yield* TasksTracker;
    const fs = yield* FileSystem.FileSystem;
    const github = yield* githubTracker(yield* checkoutRepo(yield* Fleet, yield* Repository));
    const choices = readPolicy(policyPath()).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.map(({ policy }) => policy),
    );
    const linear = yield* linearTracker((project) =>
      choices.pipe(
        Effect.flatMap((policy) => {
          const place = policy.projects[project]?.linear;
          return place === undefined
            ? Effect.fail(
                new TrackerError({
                  command: `place of ${project}`,
                  detail:
                    "no Linear team and project: run `foreman policy tracker linear --team <key> --linear-project <name>`",
                }),
              )
            : Effect.succeed(place);
        }),
      ),
    );
    return routeByProject({ tasks, github, linear }, choices);
  }),
).pipe(
  Layer.provide([Tasks.layerSql, Linear.layer, HcFleet, Repository.Default]),
  // The dispatcher's pull-request calls share this `Github`, so one ETag cache
  // serves both.
  Layer.provideMerge(Github.layer),
);

/**
 * Routes each call to `adapters[tracker of the call's project]`.
 *
 * A local tasks id carries no project, so an id without `<project>#` is the
 * tasks store's and needs no policy read. An issue id `<project>#<n>` names
 * its project. Calls that take a project route by it; `list` by a parent
 * routes by the parent's id, because an epic's children live in the epic's
 * tracker.
 *
 * A read across every project (`ready(undefined)`, `list` with no project or
 * parent) joins the tasks store's rows of tasks projects with each other
 * project's own read. A project whose read fails is left out of the join, so
 * one tracker that does not answer takes no step and does not stop the rest
 * of the fleet.
 */
export const routeByProject = (
  adapters: Readonly<Record<TrackerName, Tracker["Service"]>>,
  choices: Effect.Effect<Policy>,
): Tracker["Service"] => {
  const forProject = (project: string) =>
    choices.pipe(Effect.map((policy) => adapters[trackerOf(policy, project)]));
  const forId = (id: string) => {
    const project = projectOfId(id);
    return project === undefined ? Effect.succeed(adapters.tasks) : forProject(project);
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

  /** Local store rows of tasks projects, joined with each other project's own read. */
  const everywhere = (
    fromTasks: Effect.Effect<ReadonlyArray<Item>, TrackerError>,
    fromProject: (
      tracker: Tracker["Service"],
      project: string,
    ) => Effect.Effect<ReadonlyArray<Item>, TrackerError>,
  ) =>
    Effect.gen(function* () {
      const policy = yield* choices;
      const elsewhere = Object.keys(policy.projects).filter(
        (project) => trackerOf(policy, project) !== "tasks",
      );
      const own = (yield* fromTasks).filter((item) => !elsewhere.includes(item.project));
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
    refresh: (project) =>
      forProject(project).pipe(Effect.flatMap((tracker) => tracker.refresh(project))),
    lookup: byId((tracker, task) => tracker.lookup(task)),
    list: (filter) =>
      filter.project !== undefined
        ? forProject(filter.project).pipe(Effect.flatMap((tracker) => tracker.list(filter)))
        : filter.parent !== undefined
          ? forId(filter.parent).pipe(Effect.flatMap((tracker) => tracker.list(filter)))
          : everywhere(adapters.tasks.list(filter), (tracker, project) =>
              tracker.list({ ...filter, project }),
            ),
    dependencies: (project) =>
      forProject(project).pipe(Effect.flatMap((tracker) => tracker.dependencies(project))),
    ready: (project) =>
      project !== undefined
        ? forProject(project).pipe(Effect.flatMap((tracker) => tracker.ready(project)))
        : everywhere(adapters.tasks.ready(undefined), (tracker, each) => tracker.ready(each)),
    logs: byId((tracker, task) => tracker.logs(task)),
    add: (task) => forProject(task.project).pipe(Effect.flatMap((tracker) => tracker.add(task))),
    claim: byId((tracker, task) => tracker.claim(task)),
    reopen: byId((tracker, task) => tracker.reopen(task)),
    complete: byId((tracker, task) => tracker.complete(task)),
    cancel: byId((tracker, task) => tracker.cancel(task)),
    label: byId((tracker, task, label: string) => tracker.label(task, label)),
    unlabel: byId((tracker, task, label: string) => tracker.unlabel(task, label)),
    relabel: byId(
      (tracker, task, change: (labels: ReadonlyArray<string>) => ReadonlyArray<string>) =>
        tracker.relabel(task, change),
    ),
    log: byId((tracker, task, message: string) => tracker.log(task, message)),
    url: byId((tracker, task) => tracker.url(task)),
  });
};

/** The project an issue id `<project>#<n>` names; local tasks ids name none. */
const projectOfId = (id: string): string | undefined => {
  const hash = id.lastIndexOf("#");
  return hash > 0 ? id.slice(0, hash) : undefined;
};
