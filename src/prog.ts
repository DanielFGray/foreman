import { Command, CommandExecutor } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import type { AgentIdentity, AgentRole } from "./fleet.ts";
import type { Rung } from "./ladder.ts";

/**
 * The task store, reached through the prog CLI.
 *
 * Everything foreman knows about work comes through this service, so replacing
 * prog with an in-house store is a matter of writing another implementation of
 * this service. Nothing above this file constructs a prog command.
 */
export class Prog extends Effect.Service<Prog>()("Prog", {
  dependencies: [BunContext.layer],
  accessors: true,
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

    /**
     * Removes the attempt labels naming one rung.
     *
     * Prefix matching alone would be wrong here: a rung whose name is a prefix
     * of another's (`deepseek`, `deepseek-flash`) would clear the other's
     * count. The count must follow the label, so only labels whose suffix is a
     * plain number are that rung's.
     */
    const removeAttempts = (task: string, rung: string) =>
      show(task).pipe(
        Effect.flatMap((item) =>
          Effect.forEach(
            item.labels.filter((label) => {
              const prefix = `${ATTEMPT}${rung}-`;
              return label.startsWith(prefix) && /^[0-9]+$/.test(label.slice(prefix.length));
            }),
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
       * Records which rung of the ladder did the work, so review can pick the next.
       *
       * Replaces earlier author and reviewer ownership. A task can be attempted
       * more than once, and its next author starts a new lifecycle stage.
       */
      attribute: (task: string, kind: string) =>
        removeLabels(task, [BY, REVIEW_BY, APPROVED]).pipe(
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
       * Records which rung of the ladder a task's next dispatch must use.
       *
       * Durable in the task store rather than in foreman's memory, because the
       * evidence that a rung failed here is exactly what the next dispatch —
       * possibly days later, possibly after a restart — needs to act on. You
       * can also set the label by hand to pin a task straight to a rung,
       * including `rung-human` for one that needs a person before any agent
       * touches it.
       *
       * Any rung change is a fresh start, so the attempt labels are cleared
       * with it: a count earned on one rung says nothing about the next, and a
       * task that revisits a lower rung must not inherit the old count.
       */
      setRung: (task: string, rung: string) =>
        removeLabels(task, [RUNG, ATTEMPT]).pipe(
          Effect.andThen(run("label", task, `${RUNG}${rung}`)),
          Effect.asVoid,
        ),

      /**
       * Writes how many times the named rung has ended the task unfinished.
       *
       * The rung is named in the label, so a count follows its rung: reading
       * ignores what a rung the task left recorded, and pinning a task by hand
       * starts the pinned rung fresh. The old count for the same rung is
       * removed first, so a rung holds at most one attempt label.
       */
      markAttempt: (task: string, rung: string, count: number) =>
        removeAttempts(task, rung).pipe(
          Effect.andThen(run("label", task, `${ATTEMPT}${rung}-${count}`)),
          Effect.asVoid,
        ),

      /**
       * Removes the rung label, returning a task to the bottom-rung default.
       *
       * The operator lowering a task off the bottom rung, where the ladder
       * reads no label as the bottom and a `rung-<bottom>` would be a
       * redundant pin. Foreman itself never clears a rung — it only ever
       * replaces one on the way up — so this is an operator's correction.
       */
      clearRung: (task: string) => removeLabels(task, [RUNG]),

      markDiagnostic: (task: string, intent: DiagnosticIntent) =>
        removeLabels(task, [DIAGNOSING]).pipe(
          Effect.andThen(run("label", task, `${DIAGNOSING}${intent}`)),
          Effect.asVoid,
        ),

      clearDiagnostic: (task: string) => removeLabels(task, [DIAGNOSING]),

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
      /**
       * Returns a task to the queue, and with it the reviewer's verdict.
       *
       * `approved` says a reviewer read a diff and found it sound, so it stops
       * being true the moment the task is handed back for someone to change
       * that diff — and `awaitingLanding` reads it with no other corroboration.
       * `attribute` also clears it, which is what has kept a released approval
       * from landing unreviewed so far, but that puts the invariant a caller
       * away from the transition it belongs to. Here it holds for every path
       * that requeues a task, including one that never reaches an author.
       */
      release: (task: string) =>
        removeLabels(task, [APPROVED]).pipe(Effect.andThen(run("open", task)), Effect.asVoid),

      /**
       * Puts a task back in front of a reviewer, whatever state it was in.
       *
       * How a stranded branch rejoins the pipeline: the commits exist and
       * nobody can say whether they are any good, which is the question a
       * reviewer answers. From `reviewing` the ordinary loop takes over.
       *
       * Claims it first because prog only reviews `in_progress` work, and a
       * stranded branch's task is usually done or back in the queue.
       */
      submit: (task: string) =>
        removeLabels(task, [APPROVED]).pipe(
          Effect.andThen(run("start", task)),
          Effect.andThen(run("review", task)),
          Effect.asVoid,
        ),

      /** Moves already-claimed work to formal review, and with it any stale verdict. */
      review: (task: string) =>
        removeLabels(task, [APPROVED]).pipe(Effect.andThen(run("review", task)), Effect.asVoid),

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

      /** Marks work complete after foreman has landed its branch. */
      complete: (task: string) => run("done", task).pipe(Effect.asVoid),
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
  last_activity_at: Schema.DateFromString,
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
   * The epic's body text. Plan mode reads it to know whether the planner has
   * written a specification: the planner replaces the rough plan with the full
   * spec, so a description that changed during planning is the planner's
   * deliverable. Null only for items created without a description.
   */
  description: Schema.NullOr(Schema.String),

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
export const authoredBy = (item: { readonly labels: ReadonlyArray<string> }): string | undefined =>
  item.labels.find((label) => label.startsWith(BY))?.slice(BY.length);

/** Which reviewer currently owns a reviewing task, if one was dispatched. */
export const reviewedBy = (item: { readonly labels: ReadonlyArray<string> }): string | undefined =>
  item.labels.find((label) => label.startsWith(REVIEW_BY))?.slice(REVIEW_BY.length);

/**
 * Stable audit entry for one agent attempt on a task.
 *
 * Names the rung rather than the harness, because two rungs can share a
 * harness and differ only in model — `opencode` would say nothing about which
 * one ran. The model herdr observed is preferred over the one foreman asked
 * for, so a harness that ignored the request is visible in the log rather than
 * hidden behind foreman's intention.
 */
export const agentLog = (role: AgentRole, rung: Rung, agent: AgentIdentity): string =>
  `foreman: ${role} assigned to ${rung.name} (${agent.model ?? rung.model ?? rung.harness})`;

/** Whether the reviewer accepted the branch for mechanical landing. */
export const isApproved = (item: { readonly labels: ReadonlyArray<string> }): boolean =>
  item.labels.includes(APPROVED);

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

/**
 * Which rung of the ladder a task's next dispatch must use, if it has moved off
 * the bottom.
 *
 * Not derivable from `by-*`. A task pinned by hand has never been authored and
 * has no `by-*` label to read at all, and who authored last does not say who
 * authors next: a reviewer's rejection climbs, while an agent that stopped
 * without finishing stays on the rung until its attempts run out.
 */
export const rungOf = (item: { readonly labels: ReadonlyArray<string> }): string | undefined =>
  item.labels.find((label) => label.startsWith(RUNG))?.slice(RUNG.length);

/**
 * How many times the named rung has ended the task unfinished.
 *
 * `0` when the rung has never been tried, or was climbed away from — the label
 * names its rung, so a stale count from a rung the task left is ignored and a
 * task pinned by hand starts fresh. The count is what the escalation reads on
 * a dispatch days later.
 */
export const attemptsOf = (
  item: { readonly labels: ReadonlyArray<string> },
  rung: string,
): number => {
  const prefix = `${ATTEMPT}${rung}-`;
  const counts = item.labels
    .filter((label) => label.startsWith(prefix) && /^[0-9]+$/.test(label.slice(prefix.length)))
    .map((label) => Number(label.slice(prefix.length)));
  return counts.length === 0 ? 0 : Math.max(...counts);
};

/** Prefix of the label naming the kind that authored a task's current branch. */
export const BY = "by-";
export const REVIEW_BY = "review-by-";
export const TRIVIAL = "trivial";

/** Prefix of the label naming the rung a task's next dispatch must use. */
export const RUNG = "rung-";
export const DIAGNOSING = "diagnosing-";
export const ONBOARD = "onboard";
export const PLAN = "plan";

/** Prefix of the label counting a rung's unfinished attempts. */
export const ATTEMPT = "attempt-";

export const APPROVED = "approved";

export type DiagnosticIntent = "diagnose" | "review";

export const diagnosticIntent = (item: {
  readonly labels: ReadonlyArray<string>;
}): DiagnosticIntent | undefined => {
  const intent = item.labels
    .find((label) => label.startsWith(DIAGNOSING))
    ?.slice(DIAGNOSING.length);
  return intent === "diagnose" || intent === "review" ? intent : undefined;
};

export class ProgError extends Schema.TaggedError<ProgError>()("ProgError", {
  command: Schema.String,
  detail: Schema.String,
}) {}
