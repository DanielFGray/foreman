import { Command, CommandExecutor } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Option, Schema, Stream } from "effect";
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

    /**
     * Full detail for one task, or nothing when the store has no such task.
     *
     * "There is no such task" is an answer about the world, not a failure to
     * read it, and the two must not collapse: a workspace whose task was
     * deleted is residue to surface, while a store that would not answer says
     * nothing at all and must leave the workspace alone. prog separates them
     * itself — a missing item exits non-zero with empty stdout — so this is the
     * one command that reads the exit status rather than the output alone.
     */
    const lookup = (task: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* executor.start(
            Command.make("prog", "show", task, "--json").pipe(Command.stdout("pipe")),
          );
          const [exitCode, stdout] = yield* Effect.all(
            [process.exitCode, Stream.decodeText(process.stdout).pipe(Stream.mkString)],
            { concurrency: 2 },
          );
          return { exitCode: Number(exitCode), stdout };
        }),
      ).pipe(
        Effect.mapError(
          (cause) => new ProgError({ command: `show ${task}`, detail: String(cause) }),
        ),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Schema.decodeUnknown(Schema.parseJson(Item))(result.stdout).pipe(
                Effect.mapError(
                  (cause) => new ProgError({ command: `show ${task}`, detail: String(cause) }),
                ),
                Effect.map(Option.some),
              )
            : Effect.succeedNone,
        ),
      );

    /** Full detail for one task, failing when the store has no such task. */
    const show = (task: string) =>
      lookup(task).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              new ProgError({ command: `show ${task}`, detail: "no such task in the store" }),
            onSome: Effect.succeed,
          }),
        ),
      );

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
      lookup,

      /** All unblocked, unclaimed tasks, highest priority first. */
      ready: () => runJson(Schema.Array(ReadyTask), "ready", "--json"),

      /**
       * Every item carrying the focus label — tasks, epics, or a mix.
       *
       * The scope a focus defines is derived from these roots each tick: every
       * ready task at or under any of them. Read from the store rather than
       * remembered, so the scope survives a restart the way the `by-*` and
       * `rung-*` labels do.
       */
      pinned: () => runJson(Schema.Array(Item), "list", "--label", PIN, "--json"),

      setPin: (task: string, pinned: boolean) =>
        (pinned ? run("label", task, PIN) : run("unlabel", task, PIN)).pipe(Effect.asVoid),

      /** Tasks whose author is finished and which are waiting to be reviewed. */
      awaitingReview: (project: string) => byStatus(project, "reviewing"),

      /** Epics currently being driven, with their progress read separately by the caller. */
      inProgressEpics: (project: string) =>
        runJson(
          Schema.Array(Item),
          "list",
          "-p",
          project,
          "--status",
          "in_progress",
          "--type",
          "epic",
          "--json",
        ),

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
        removeLabels(task, [BY, REVIEW_BY, APPROVED, SATISFIED]).pipe(
          Effect.andThen(run("label", task, `${BY}${kind}`)),
          Effect.asVoid,
        ),

      /** Records that a reviewer, rather than the author, owns the live pane. */
      assignReview: (task: string, kind: string) =>
        removeLabels(task, [REVIEW_BY]).pipe(
          Effect.andThen(run("label", task, `${REVIEW_BY}${kind}`)),
          Effect.asVoid,
        ),

      /**
       * Ends a review, and the verdict that went with it.
       *
       * The verdict says a reviewer read a diff and found it sound, so it stops
       * being true the moment the review ends without landing — whichever way
       * that happens: the reviewer sent the work back, never started, or the
       * operator cleared it as stale. Leaving `approved` behind is the exact
       * failure `awaitingLanding` reads: a task back in the queue still
       * labelled as approved is a pre-approved branch waiting for its next
       * author, and a reviewer can approve and then return work in the same
       * turn.
       */
      clearReview: (task: string) => removeLabels(task, [REVIEW_BY, APPROVED, SATISFIED]),

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

      /**
       * Returns a task to the queue, and with it everything the last review
       * said about it.
       *
       * `approved` says a reviewer read a diff and found it sound, so it stops
       * being true the moment the task is handed back for someone to change
       * that diff — and `awaitingLanding` reads it with no other corroboration.
       * `attribute` also clears it, which is what has kept a released approval
       * from landing unreviewed so far, but that puts the invariant a caller
       * away from the transition it belongs to. Here it holds for every path
       * that requeues a task, including one that never reaches an author.
       *
       * `review-by-*` goes for a sharper reason: left behind, it is read as
       * evidence of something that never happened. A reviewer that is over and
       * a task that is open is exactly the shape a rejection leaves, so the
       * settle loop takes it for one — climbing a second rung and logging that
       * the reviewer sent work back, on a task whose reviewer approved it and
       * whose landing failed on the machine. The label is the only record that
       * a review was dispatched, so whatever ends the review must be what
       * clears it.
       */
      release: (task: string) =>
        removeLabels(task, [APPROVED, REVIEW_BY, SATISFIED]).pipe(
          Effect.andThen(run("open", task)),
          Effect.asVoid,
        ),

      /**
       * Puts a task back in front of a reviewer, whatever state it was in.
       *
       * How an unread branch rejoins the pipeline: the commits exist and
       * nobody can say whether they are any good, which is the question a
       * reviewer answers. From `reviewing` the ordinary loop takes over.
       *
       * Claims it first because prog only reviews `in_progress` work, and an
       * unread branch's task is usually back in the queue, or done, or gone.
       */
      submit: (task: string) =>
        removeLabels(task, [APPROVED, SATISFIED]).pipe(
          Effect.andThen(run("start", task)),
          Effect.andThen(run("review", task)),
          Effect.asVoid,
        ),

      /** Moves already-claimed work to formal review, and with it any stale verdict. */
      review: (task: string) =>
        removeLabels(task, [APPROVED, SATISFIED]).pipe(
          Effect.andThen(run("review", task)),
          Effect.asVoid,
        ),

      /** Appends to the task's audit trail. Also counts as activity. */
      log: (task: string, message: string) => run("log", task, message).pipe(Effect.asVoid),

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
  created_at: Schema.DateFromString,

  /**
   * Read here so the queue stays one call per tick.
   *
   * The dashboard shows a queued task's description in the same pane as every
   * other row's, and fetching it per selected row would be a `prog show` on
   * each cursor movement against the store the dispatcher is already reading.
   */
  description: Schema.NullOr(Schema.String),
});
export type ReadyTask = typeof ReadyTask.Type;

/** Status values returned by prog for epics and tasks. */
export const TaskStatus = Schema.Literal(
  "draft",
  "open",
  "in_progress",
  "reviewing",
  "done",
  "canceled",
);
export type TaskStatus = typeof TaskStatus.Type;

export const Item = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: TaskStatus,
  project: Schema.String,
  type: Schema.String,
  priority: Schema.Number,
  labels: Schema.Array(Schema.String),

  /**
   * The epic's body text. Null only for items created without a description.
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

  /**
   * When the task was filed, which is what the queue ages against.
   *
   * An Item stands in for a ReadyTask wherever the dispatcher requeues one it
   * has already read in full, so the two must agree about what the queue reads.
   */
  created_at: Schema.DateFromString,
});
export type Item = typeof Item.Type;

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
 * The author's claim that the trunk already does what the task asks.
 *
 * A backlog outlives the code it describes: work gets done under another
 * task's branch, or by hand, and the entry for it stays open. An author sent
 * to one of those has nothing to write, and every ending it can reach says
 * something false. Committing anything at all fabricates work; stopping is
 * read as a crash, which costs a rung and dispatches the same discovery again
 * at a more expensive model, forever.
 *
 * So the finding is a claim the author records, and the branch it hands over
 * is legitimately empty. It is a claim and not a verdict: "it is already done"
 * is exactly what a model too weak for the task would say to escape it, so a
 * reviewer confirms it against the trunk like any other diff, and only its
 * `approved` closes the task. It is cleared wherever `approved` is, for the
 * same reason — both describe a diff that a requeue has invalidated.
 */
export const isSatisfied = (item: { readonly labels: ReadonlyArray<string> }): boolean =>
  item.labels.includes(SATISFIED);

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
 * A pinned item. The label is the whole scope: put it on a task, an epic, or
 * several items, and every ready task at or under them leads the queue.
 */
export const isPinned = (item: { readonly labels: ReadonlyArray<string> }): boolean =>
  item.labels.includes(PIN);

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

/** The label that marks a task as a defect in shipped code rather than new work. */
export const BUG = "bug";

/** Prefix of the label naming the rung a task's next dispatch must use. */
export const RUNG = "rung-";
export const DIAGNOSING = "diagnosing-";
export const ONBOARD = "onboard";

/**
 * Marks an item whose ready descendants lead the queue.
 *
 * A label and nothing else. Writing priority instead would overwrite a value
 * that already means something, which then needs the old one stashed somewhere
 * to restore on unpin — and the only place to stash it is prose in a log line,
 * which is a database hidden in a comment field.
 */
export const PIN = "pin";

/** Prefix of the label counting a rung's unfinished attempts. */
export const ATTEMPT = "attempt-";
export const APPROVED = "approved";

/** The label carrying an author's claim that the trunk already satisfies a task. */
export const SATISFIED = "satisfied";

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
