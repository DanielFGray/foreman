import { Context, Effect, Layer, Option, Schema as S } from "effect";
import { Tasks, TaskError, type Item, type LogEntry, type TaskEvent } from "tasks";
import type { AgentIdentity, AgentRole } from "./fleet.ts";
import type { Rung } from "./ladder.ts";

export type { Item, Status as TaskStatus } from "tasks";

/**
 * The task store, and the run records foreman keeps on its tasks as labels.
 *
 * Everything foreman knows about work comes through this service. The store is
 * the `tasks` package, in process; this file owns what foreman's labels mean
 * and which status move each of foreman's operations is.
 */
export class Prog extends Context.Service<Prog>()("Prog", {
  make: Effect.gen(function* () {
    const tasks = yield* Tasks;

    /** Runs a store call, naming the operation in its failure. */
    const as =
      (command: string) =>
      <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, ProgError> =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProgError({
                command,
                detail: cause instanceof TaskError ? cause.detail : String(cause),
              }),
          ),
        );

    const send = (task: string, event: TaskEvent) =>
      tasks.send(task, event).pipe(as(`${event} ${task}`), Effect.asVoid);

    /** Rewrites a task's labels in one transaction, answering the ones it carried before. */
    const relabel = (
      task: string,
      change: (labels: ReadonlyArray<string>) => ReadonlyArray<string>,
    ) => tasks.relabel(task, change).pipe(as(`relabel ${task}`));

    /** Drops every label of the named kinds, whatever value each carries, then adds `added`. */
    const replaceKinds = (task: string, kinds: ReadonlyArray<string>, ...added: Array<string>) =>
      relabel(task, (labels) => [
        ...labels.filter((label) => !kinds.includes(kindOf(label))),
        ...added,
      ]).pipe(Effect.asVoid);

    /** Drops the attempt count of one rung, leaving every other rung's alone, then adds `added`. */
    const replaceAttempts = (task: string, rung: string, added: string) =>
      relabel(task, (labels) => [
        ...labels.filter((label) => attemptFor(label, rung) === undefined),
        added,
      ]).pipe(Effect.asVoid);

    /**
     * One task, or nothing when the store has no such task.
     *
     * "There is no such task" is an answer about the world, not a failure to
     * read it, and the two must not collapse: a workspace whose task was
     * deleted is residue to surface, while a store that would not answer says
     * nothing at all and must leave the workspace alone.
     */
    const lookup = (task: string) => tasks.get(task).pipe(as(`show ${task}`));

    /** One task, failing when the store has no such task. */
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

    /** The items that belong to one epic. */
    const children = (epic: string) =>
      tasks.list({ parent: epic }).pipe(as(`list --parent ${epic}`));

    /**
     * One project's tasks in a given status.
     *
     * Tasks only. An epic is a container that stays `in_progress` for as long
     * as it has children, so an unfiltered status query returns every epic in
     * the backlog as an ancient claim with no worker behind it — and the sweep
     * dutifully hands them all back.
     */
    const byStatus = (project: string, status: "in_progress" | "reviewing" | "done") =>
      tasks
        .list({ project, status, type: "task" })
        .pipe(as(`list -p ${project} --status ${status}`));

    return {
      show,
      lookup,

      /** A task with its log, for a reader showing it whole. */
      detail: (task: string) =>
        Effect.all([lookup(task), tasks.logs(task).pipe(as(`show ${task}`))]).pipe(
          Effect.map(([item, logs]) =>
            Option.map(item, (found): TaskDetail => ({ ...found, logs })),
          ),
        ),

      /** Unblocked, unclaimed tasks, in every project or in one. */
      ready: (project: Option.Option<string>) =>
        tasks.ready(Option.getOrUndefined(project)).pipe(as("ready")),

      /** Tasks whose author is finished and which are waiting to be reviewed. */
      awaitingReview: (project: string) => byStatus(project, "reviewing"),

      /**
       * The epics being driven that these tasks sit under, each with its
       * direct children.
       *
       * Only an epic with a task in hand can change that task's rank, so the
       * children of every other epic are not read.
       */
      epicsOver: (over: ReadonlyArray<{ readonly parent: string | undefined }>) =>
        tasks.list({ status: "in_progress", type: "epic" }).pipe(
          as("list --status in_progress --type epic"),
          Effect.flatMap((epics) =>
            Effect.forEach(
              epics.filter((epic) => over.some((task) => task.parent === epic.id)),
              (epic) =>
                children(epic.id).pipe(
                  Effect.map((items): EpicProgress => ({ epic, children: items })),
                ),
              { concurrency: "unbounded" },
            ),
          ),
        ),

      /**
       * Every completed task in one project.
       *
       * The store has no limit, so the caller filters this to recent work by
       * `lastActivityAt`; nothing above this file decides what "recent" is.
       */
      landed: (project: string) => byStatus(project, "done"),

      /**
       * Records which rung of the ladder did the work, so review can pick the next.
       *
       * Replaces earlier author and reviewer ownership. A task can be attempted
       * more than once, and its next author starts a new lifecycle stage. The
       * correction count goes too: it counts this author's rounds, not the task's.
       */
      attribute: (task: string, kind: string) =>
        replaceKinds(
          task,
          [BY, REVIEW_BY, REVIEW_FAILED, APPROVED, SATISFIED, ROUNDS],
          `${BY}:${kind}`,
        ),

      /**
       * Counts one more correction round sent to the current author, and
       * answers the new count.
       */
      countRound: (task: string) =>
        relabel(task, (labels) => [
          ...labels.filter((label) => kindOf(label) !== ROUNDS),
          `${ROUNDS}:${nextRound(labels)}`,
        ]).pipe(Effect.map(nextRound)),

      /** Records that a reviewer, rather than the author, owns the live pane. */
      assignReview: (task: string, kind: string) =>
        replaceKinds(task, [REVIEW_BY], `${REVIEW_BY}:${kind}`),

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
      clearReview: (task: string) =>
        replaceKinds(task, [REVIEW_BY, REVIEW_FAILED, APPROVED, SATISFIED]),

      /**
       * Ends a review that gave no verdict, leaving the task in `reviewing` for
       * the next reviewer. Touches only `review-by`: `satisfied` is the
       * author's claim and the next reviewer needs it, and the reviewers that
       * already failed stay recorded.
       */
      endReview: (task: string) => replaceKinds(task, [REVIEW_BY]),

      /**
       * Ends a review whose reviewer stopped without a verdict, and records that
       * rung so the next reviewer is chosen above it.
       */
      failReview: (task: string, rung: string) =>
        replaceKinds(task, [REVIEW_BY], `${REVIEW_FAILED}:${rung}`),

      /** Parks a task in the operator's column, whatever the ladder would say. */
      parkForOperator: (task: string) =>
        tasks.label(task, NEEDS_YOU).pipe(as(`label ${task} ${NEEDS_YOU}`)),

      /** Records that the task's agent stopped on this account's usage wall. */
      markWall: (task: string, provider: string) =>
        tasks.label(task, `${WALLED}:${provider}`).pipe(as(`label ${task} ${WALLED}`)),

      /**
       * Records that a rung was tried on this task and was not enough.
       *
       * Durable in the task store rather than in foreman's memory, because this
       * is exactly what the next dispatch — possibly days later, possibly after
       * a restart — reads to decide which model gets the work. It names the
       * rung that failed, never the one that runs next: what runs next depends
       * on which rungs are configured and paid for at the moment of dispatch,
       * and a task that stated that in advance would be stranded by a config
       * edit or a spent account.
       *
       * The rung's attempt count goes with it. The count exists to decide when
       * the rung is spent; once it is spent, the count has been read for the
       * last time, and leaving it behind would let a task lowered back onto
       * that rung inherit a verdict it has not earned again.
       */
      markFailure: (task: string, rung: string) =>
        replaceAttempts(task, rung, `${FAILED_BY}:${rung}`),

      /**
       * Writes how many times the named rung has ended the task unfinished.
       *
       * The rung is named in the label, so a count follows its rung: reading
       * ignores what a rung the task left recorded, and pinning a task by hand
       * starts the pinned rung fresh. The old count for the same rung goes in
       * the same write, so a rung holds at most one attempt label.
       */
      markAttempt: (task: string, rung: string, count: number) =>
        replaceAttempts(task, rung, `${ATTEMPT}:${rung}:${count}`),

      /**
       * Takes back the record that one rung failed this task.
       *
       * The operator's correction, and only ever theirs: foreman writes failure
       * evidence and never unwrites it. A rung is only as good as what wrote
       * it, and a crash, an OOM or a killed run all write one that nothing
       * earned — so removing the highest failure is exactly "that climb was not
       * deserved", and the work drops back to the model below.
       */
      clearFailure: (task: string, rung: string) =>
        relabel(task, (labels) =>
          labels.filter((label) => valueOf(label, FAILED_BY) !== rung),
        ).pipe(Effect.asVoid),

      /** Puts a task a person parked back in the queue at the rung it had earned. */
      clearNeedsYou: (task: string) =>
        tasks.unlabel(task, NEEDS_YOU).pipe(as(`unlabel ${task} ${NEEDS_YOU}`)),

      markDiagnostic: (task: string, intent: DiagnosticIntent) =>
        replaceKinds(task, [DIAGNOSING], `${DIAGNOSING}:${intent}`),

      clearDiagnostic: (task: string) => replaceKinds(task, [DIAGNOSING]),

      /** Claimed tasks in one project, carrying the timestamps a sweep needs. */
      claimed: (project: string) => byStatus(project, "in_progress"),

      /** Creates a task and returns its id. */
      add: (project: string, title: string, description: string, labels: ReadonlyArray<string>) =>
        tasks.add({ project, title, description, labels }).pipe(as(`add ${title}`)),

      /** Claims a task. After this the task is invisible to `ready`. */
      claim: (task: string) => send(task, "start"),

      /**
       * Returns a task to the queue, and with it everything the last review
       * said about it.
       *
       * `approved` says a reviewer read a diff and found it sound, so it stops
       * being true the moment the task is handed back for someone to change
       * that diff — and `awaitingLanding` reads it with no other corroboration.
       * Here it holds for every path that requeues a task, including one that
       * never reaches an author.
       *
       * `review-by:*` goes for a sharper reason: left behind, it is read as
       * evidence of something that never happened. A reviewer that is over and
       * a task that is open is exactly the shape a rejection leaves, so the
       * settle loop takes it for one — climbing a second rung and logging that
       * the reviewer sent work back, on a task whose reviewer approved it and
       * whose landing failed on the machine. The label is the only record that
       * a review was dispatched, so whatever ends the review must be what
       * clears it.
       */
      release: (task: string) =>
        replaceKinds(task, [APPROVED, REVIEW_BY, REVIEW_FAILED, SATISFIED]).pipe(
          Effect.andThen(send(task, "open")),
        ),

      /**
       * Puts a task with an unread branch in front of a reviewer, from whatever
       * state it was left in: the commits exist and nobody can say whether
       * they are any good, which is the question a reviewer answers. From
       * `reviewing` the ordinary loop takes over.
       */
      submit: (task: string) =>
        replaceKinds(task, [APPROVED, SATISFIED]).pipe(Effect.andThen(send(task, "submit"))),

      /** Moves already-claimed work to formal review, and with it any stale verdict. */
      review: (task: string) =>
        replaceKinds(task, [APPROVED, SATISFIED]).pipe(Effect.andThen(send(task, "review"))),

      /** Appends to the task's audit trail. Also counts as activity. */
      log: (task: string, message: string) => tasks.log(task, message).pipe(as(`log ${task}`)),

      children,

      /**
       * Marks work complete after foreman has landed its branch. Done first, so
       * a task that cannot be completed fails on `done` itself. A wall label
       * left on a done task is inert: nothing dispatches it.
       */
      complete: (task: string) =>
        send(task, "done").pipe(Effect.andThen(replaceKinds(task, [WALLED]))),
    } as const;
  }),
}) {
  static readonly Default = Layer.effect(this, this.make).pipe(Layer.provide(Tasks.layerSql));
}

const nextRound = (labels: ReadonlyArray<string>): number => (countOf({ labels }, ROUNDS) ?? 0) + 1;

/** An epic being driven, and its direct children: how close it is to done. */
export interface EpicProgress {
  readonly epic: Item;
  readonly children: ReadonlyArray<Item>;
}

/** One task as a reader shows it whole: the item and its log. */
export interface TaskDetail extends Item {
  readonly logs: ReadonlyArray<LogEntry>;
}

/** Which kind of agent authored the work, if foreman recorded it. */
export const authoredBy = (item: { readonly labels: ReadonlyArray<string> }): string | undefined =>
  valuesOfKind(item.labels, BY)[0];

/** Which reviewer currently owns a reviewing task, if one was dispatched. */
export const reviewedBy = (item: { readonly labels: ReadonlyArray<string> }): string | undefined =>
  valuesOfKind(item.labels, REVIEW_BY)[0];

/** The rungs whose reviewers stopped on this task without a verdict. */
export const reviewFailedBy = (item: {
  readonly labels: ReadonlyArray<string>;
}): ReadonlyArray<string> => valuesOfKind(item.labels, REVIEW_FAILED);

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
 * Whether a task's deliverable is a report rather than code.
 *
 * The report lives in the task's own log, so the branch is legitimately empty
 * and the reviewer reads evidence instead of a diff. `research` is set when the
 * task is filed and survives every attempt, unlike `satisfied`, which is the
 * author's claim about one attempt.
 */
export const isResearch = (item: { readonly labels: ReadonlyArray<string> }): boolean =>
  item.labels.includes(RESEARCH);

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
 * Which rungs have already failed this task.
 *
 * The durable half of choosing an author: the ladder reads these as a floor and
 * picks the cheapest rung above them that is available now. Evidence rather
 * than a pointer, so retiring a model or spending its allowance moves the work
 * on instead of naming a rung nothing can dispatch.
 *
 * Not derivable from `by:*`. A task pinned by hand has never been authored and
 * has no `by:*` label to read at all, and who authored last does not say who
 * authors next: a reviewer's rejection fails the rung, while an agent that
 * stopped without finishing leaves it standing until its attempts run out.
 */
export const failuresOf = (item: {
  readonly labels: ReadonlyArray<string>;
}): ReadonlyArray<string> => valuesOfKind(item.labels, FAILED_BY);

/**
 * Whether a person has parked this task, whatever the ladder would say.
 *
 * The one durable way into the operator's column. Everything else there is
 * derived from the failures and the config, so it clears itself when a rung is
 * added or an allowance resets; this one is a decision and only a decision
 * removes it.
 */
export const needsYou = (item: { readonly labels: ReadonlyArray<string> }): boolean =>
  item.labels.includes(NEEDS_YOU);

/**
 * How many times the named rung has ended the task unfinished.
 *
 * `0` when the rung has never been tried, or when the failure it earned was
 * recorded and its count cleared with it. The label names its rung, so one
 * rung's count is never read as another's, and the count is what the
 * escalation reads on a dispatch days later.
 */
export const attemptsOf = (
  item: { readonly labels: ReadonlyArray<string> },
  rung: string,
): number => {
  const counts = item.labels.flatMap((label) => {
    const count = attemptFor(label, rung);
    return count === undefined ? [] : [count];
  });
  return counts.length === 0 ? 0 : Math.max(...counts);
};

/**
 * Every label foreman writes is `<kind>:<value>`, so reading one is a split.
 *
 * The separator is not decoration. Rung names contain hyphens, so under the
 * older `attempt-<rung>-<n>` a label could only be read by guessing where the
 * model's name ended — and labels are durable, so the guess was made again on
 * every dispatch for the whole life of the task. Splitting on a character that
 * appears in no name asks nothing and cannot be fooled by a rung named after
 * another rung's prefix.
 */
export const kindOf = (label: string): string => label.split(":")[0] ?? label;

/** What a label of this kind says, or nothing if it is not one. */
export const valueOf = (label: string, kind: string): string | undefined => {
  const [head, ...rest] = label.split(":");
  return head === kind && rest.length > 0 ? rest.join(":") : undefined;
};

const valuesOfKind = (labels: ReadonlyArray<string>, kind: string): ReadonlyArray<string> =>
  labels.flatMap((label) => {
    const value = valueOf(label, kind);
    return value === undefined ? [] : [value];
  });

/**
 * The count an `attempt:<rung>:<n>` label carries for one rung.
 *
 * Both halves are checked, so a rung reads only its own counts and a label
 * whose tail is not a number is somebody else's convention rather than a zero.
 */
const attemptFor = (label: string, rung: string): number | undefined => {
  const [kind, named, count, ...rest] = label.split(":");
  if (kind !== ATTEMPT || named !== rung || count === undefined || rest.length > 0)
    return undefined;
  return /^[0-9]+$/.test(count) ? Number(count) : undefined;
};

/** Kind of the label naming the rung that authored a task's current branch. */
export const BY = "by";
export const REVIEW_BY = "review-by";

/**
 * Kind of the label naming a rung whose reviewer stopped without a verdict, one
 * per rung. The next review is chosen above every one of them. They go with the
 * author, because they describe this branch's reviews, not the task's.
 */
export const REVIEW_FAILED = "review-failed-by";

/**
 * How big a slice is, as the coordinator judged it when filing: `size:1` one
 * file or rule, `size:2` one package, `size:3` crosses packages. Larger is
 * allowed. An integer, so the trials record can compare sizes by order.
 */
export const SIZE = "size";

/** How many correction rounds the current author has been sent. */
export const ROUNDS = "rounds";

/** The positive integer a label of this kind carries, or nothing. */
export const countOf = (
  item: { readonly labels: ReadonlyArray<string> },
  kind: string,
): number | undefined => {
  const values = valuesOfKind(item.labels, kind)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 0);
  return values.length === 0 ? undefined : Math.max(...values);
};

/** Kind of the label recording that a rung was tried here and was not enough. */
export const FAILED_BY = "failed-by";

/** The label that marks a task as a defect in shipped code rather than new work. */
export const BUG = "bug";

export const DIAGNOSING = "diagnosing";
export const ONBOARD = "onboard";

/** The label with which a person parks a task in their own column. */
export const NEEDS_YOU = "needs-you";

/** Prefix of the label counting a rung's unfinished attempts: `attempt:<rung>:<n>`. */
export const ATTEMPT = "attempt";
export const APPROVED = "approved";

/** The label carrying an author's claim that the trunk already satisfies a task. */
export const SATISFIED = "satisfied";

/**
 * The label marking a task whose deliverable is a report, not code.
 *
 * Set when the task is filed and never cleared: it says what kind of work this
 * is, so an empty branch that reaches review is a report to read rather than an
 * author that wrote nothing.
 */
export const RESEARCH = "research";

/**
 * The account a task's agent stopped on, one label per provider. A stop on a
 * usage wall says nothing about the model, so the task is not failed; the label
 * only keeps rungs on that account off the task's next dispatch. Cleared when
 * the task completes, because the wall describes the account at that time.
 */
export const WALLED = "walled";

/** The accounts a task's agents have stopped on a usage wall. */
export const walledBy = (item: { readonly labels: ReadonlyArray<string> }): ReadonlyArray<string> =>
  valuesOfKind(item.labels, WALLED);

export type DiagnosticIntent = "diagnose" | "review";

export const diagnosticIntent = (item: {
  readonly labels: ReadonlyArray<string>;
}): DiagnosticIntent | undefined => {
  const intent = valuesOfKind(item.labels, DIAGNOSING)[0];
  return intent === "diagnose" || intent === "review" ? intent : undefined;
};

export class ProgError extends S.TaggedError<ProgError>()("ProgError", {
  command: S.String,
  detail: S.String,
}) {
  override get message() {
    return `${this.command}: ${this.detail}`;
  }
}
