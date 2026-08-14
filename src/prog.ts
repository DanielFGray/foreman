import { Command, CommandExecutor } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Schema } from "effect";

/**
 * The task store, reached through the prog CLI.
 *
 * Everything foreman knows about work comes through this service, so replacing
 * prog with an in-house store is a matter of writing another implementation of
 * this service. Nothing above this file constructs a prog command.
 */
export class Prog extends Effect.Service<Prog>()("Prog", {
  dependencies: [BunContext.layer],
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;

    const run = (...args: Array<string>) =>
      executor
        .string(Command.make("prog", ...args))
        .pipe(
          Effect.mapError(
            (cause) => new ProgError({ command: args.join(" "), detail: String(cause) }),
          ),
        );

    const runJson = <A, I>(schema: Schema.Schema<A, I>, ...args: Array<string>) =>
      run(...args).pipe(
        Effect.flatMap((out) =>
          Schema.decodeUnknown(Schema.parseJson(schema))(out).pipe(
            Effect.mapError(
              (cause) => new ProgError({ command: args.join(" "), detail: String(cause) }),
            ),
          ),
        ),
      );

    /** Full detail for one task, including its current status. */
    const show = (task: string) => runJson(Item, "show", task, "--json");

    /**
     * One project's tasks in a given status.
     *
     * Tasks only. An epic is a container that stays `in_progress` for as long
     * as it has children, so an unfiltered status query returns every epic in
     * the backlog as an ancient claim with no worker behind it — and the sweep
     * dutifully hands them all back.
     */
    const byStatus = (project: string, status: string) =>
      runJson(
        Schema.Array(Item),
        "list",
        "-p",
        project,
        "--status",
        status,
        "--type",
        "task",
        "--json",
      );

    const removeLabels = (task: string, prefixes: ReadonlyArray<string>) =>
      show(task).pipe(
        Effect.flatMap((item) =>
          Effect.forEach(
            item.labels.filter((label) => prefixes.some((prefix) => label.startsWith(prefix))),
            (label) => run("unlabel", task, label),
            { discard: true },
          ),
        ),
        Effect.asVoid,
      );

    return {
      show,

      /** All unblocked, unclaimed tasks, highest priority first. */
      ready: () => runJson(Schema.Array(ReadyTask), "ready", "--json"),

      /** Tasks whose author is finished and which are waiting to be reviewed. */
      awaitingReview: (project: string) => byStatus(project, "reviewing"),

      /**
       * Every completed task in one project.
       *
       * prog list has no limit, so the caller filters this to recent work by
       * `last_activity_at`; nothing above this file decides what "recent" is.
       */
      landed: (project: string) => byStatus(project, "done"),

      /**
       * Records which kind of agent did the work, so review can escalate.
       *
       * Replaces earlier author and reviewer ownership. A task can be attempted
       * more than once, and its next author starts a new lifecycle stage.
       */
      attribute: (task: string, kind: string) =>
        removeLabels(task, [BY, REVIEW_BY]).pipe(
          Effect.andThen(run("label", task, `${BY}${kind}`)),
          Effect.asVoid,
        ),

      /** Records that a reviewer, rather than the author, owns the live pane. */
      assignReview: (task: string, kind: string) =>
        removeLabels(task, [REVIEW_BY]).pipe(
          Effect.andThen(run("label", task, `${REVIEW_BY}${kind}`)),
          Effect.asVoid,
        ),

      /** Rolls back reviewer ownership when the reviewer never started. */
      clearReview: (task: string) => removeLabels(task, [REVIEW_BY]),

      /**
       * Marks a task as needing a stronger model next time it is picked up.
       *
       * Durable in the task store rather than in foreman's memory, because the
       * evidence that cheap failed here is exactly what the next dispatch —
       * possibly days later, possibly after a restart — needs to act on. You
       * can also set the label by hand to force a task straight to frontier.
       */
      escalate: (task: string) => run("label", task, ESCALATED).pipe(Effect.asVoid),

      /** Claimed tasks in one project, carrying the timestamps a sweep needs. */
      claimed: (project: string) => byStatus(project, "in_progress"),

      /**
       * Creates a task and returns its id.
       *
       * The id is the only thing prog prints, and everything downstream — the
       * workspace label, the rescue branch, the summary — is named from it. A
       * malformed one would produce a workspace nobody can find, so it is
       * checked here rather than discovered three calls later.
       */
      add: (project: string, title: string, description: string, labels: ReadonlyArray<string>) =>
        run(
          "add",
          title,
          "-p",
          project,
          "-d",
          description,
          ...labels.flatMap((l) => ["-l", l]),
        ).pipe(
          Effect.flatMap((out) => {
            const id = out.trim();
            return /^ts-[0-9a-f]{6}$/.test(id)
              ? Effect.succeed(id)
              : Effect.fail(
                  new ProgError({ command: `add ${title}`, detail: `unusable id: ${id}` }),
                );
          }),
        ),

      /** Claims a task. After this the task is invisible to `ready`. */
      claim: (task: string) => run("start", task).pipe(Effect.asVoid),

      /** Returns a claimed task to the queue. */
      release: (task: string) => run("open", task).pipe(Effect.asVoid),

      /** Appends to the task's audit trail. Also counts as activity. */
      log: (task: string, message: string) => run("log", task, message).pipe(Effect.asVoid),

      /**
       * Creates a plan epic and returns its id.
       *
       * A plan is an epic so its generated tasks can hang off it as children,
       * and it starts in draft so nothing the fleet reads considers it ready
       * until the planner has written the specification and opened it. Same id
       * validation as `add`: the workspace, branch and prompts are all named
       * from the id, so a malformed one is caught here rather than discovered
       * three calls later.
       */
      addEpic: (
        project: string,
        title: string,
        description: string,
        labels: ReadonlyArray<string>,
      ) =>
        run(
          "add",
          title,
          "-p",
          project,
          "-e",
          "--draft",
          "-d",
          description,
          ...labels.flatMap((l) => ["-l", l]),
        ).pipe(
          Effect.flatMap((out) => {
            const id = out.trim();
            return /^ep-[0-9a-f]{6}$/.test(id)
              ? Effect.succeed(id)
              : Effect.fail(
                  new ProgError({ command: `add -e ${title}`, detail: `unusable id: ${id}` }),
                );
          }),
        ),

      /** The items that belong to one epic. */
      children: (epic: string) => runJson(Schema.Array(Item), "list", "--parent", epic, "--json"),
    } as const;
  }),
}) {}

/** A task the queue may hand out. Epics are never ready; only tasks are. */
export const ReadyTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  priority: Schema.Number,
  project: Schema.String,
  labels: Schema.Array(Schema.String),
});
export type ReadyTask = typeof ReadyTask.Type;

export const Item = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  project: Schema.String,
  type: Schema.String,
  priority: Schema.Number,
  labels: Schema.Array(Schema.String),

  /**
   * Later of the task's own update time and its newest log entry.
   *
   * The reclaimer needs this rather than updated_at: logging does not touch the
   * item row, so on a claimed task updated_at only records when it was claimed,
   * and a worker that has been logging steadily for six hours would look as
   * stale as one that died immediately.
   */
  last_activity_at: Schema.DateFromString,
});
export type Item = typeof Item.Type;

/**
 * Work substantial enough to be worth a second agent's time.
 *
 * Priority 3 is the backlog's own statement that a task is minor, and the
 * `trivial` label is the escape hatch for the ones priority does not capture.
 */
export const needsReview = (item: {
  readonly priority: number;
  readonly labels: ReadonlyArray<string>;
}): boolean => item.priority < 3 && !item.labels.includes(TRIVIAL);

/** Which kind of agent authored the work, if foreman recorded it. */
export const authoredBy = (item: Item): string | undefined =>
  item.labels.find((label) => label.startsWith(BY))?.slice(BY.length);

/** Which reviewer currently owns a reviewing task, if one was dispatched. */
export const reviewedBy = (item: Item): string | undefined =>
  item.labels.find((label) => label.startsWith(REVIEW_BY))?.slice(REVIEW_BY.length);

/**
 * Salvage work in a project's own checkout, which only the operator starts.
 *
 * The queue holds work the fleet may pick up by itself. An onboarding run is
 * not that: it stands in a directory a person is using, so it happens when they
 * ask for it and never because a slot came free. The label keeps it out of the
 * queue for as long as the task exists, including after a failed attempt.
 */
export const isOnboarding = (item: { readonly labels: ReadonlyArray<string> }): boolean =>
  item.labels.includes(ONBOARD);

/**
 * A plan epic: a rough plan that is being turned into a specification and then
 * into tasks. The label is what a resume validates against, and what a future
 * dashboard column groups on.
 */
export const isPlan = (item: { readonly labels: ReadonlyArray<string> }): boolean =>
  item.labels.includes(PLAN);

/** Cheap already failed on this task, or a human asked for frontier directly. */
export const isEscalated = (item: { readonly labels: ReadonlyArray<string> }): boolean =>
  item.labels.includes(ESCALATED);

/** Prefix of the label naming the kind that authored a task's current branch. */
export const BY = "by-";
export const REVIEW_BY = "review-by-";
export const TRIVIAL = "trivial";
export const ESCALATED = "escalated";
export const ONBOARD = "onboard";
export const PLAN = "plan";

export class ProgError extends Schema.TaggedError<ProgError>()("ProgError", {
  command: Schema.String,
  detail: Schema.String,
}) {}
