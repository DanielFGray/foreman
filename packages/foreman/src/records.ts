import { Context, Effect, Layer, Option, Schema as S } from "effect";
import { SqlClient } from "effect/sql";
import {
  addRound,
  closeOpenRuns,
  deleteOpenRunOf,
  landAuthorRun,
  openRun,
  recordCheck,
  recordExit,
  runsOf,
  type Ending,
  type CheckRun,
  type Item as TaskItem,
  type LogEntry,
  type NewRun,
  type Role,
  type Run,
} from "tasks";
import type { AgentIdentity, AgentRole } from "./fleet.ts";
import type { Rung } from "./ladder.ts";
import { TasksTracker, Tracker, TrackerError } from "./tracker.ts";

export type { Status as TaskStatus } from "tasks";

/**
 * A task as foreman reads it: the tracker's item, the runs on it oldest first,
 * and the tip of its branch.
 *
 * The tip is not in the store. The dispatcher's observation stamps it from git,
 * because an approval is bound to the commit the reviewer read (`lap.ts`); a
 * task read any other way has none.
 */
export interface Item extends TaskItem {
  readonly runs: ReadonlyArray<Run>;
  readonly tip: string | undefined;
}

/** The endings a release closes a task's open runs with, per role. */
export interface Endings {
  readonly author?: Ending;
  readonly review?: Ending;
}

/** The status move an exit makes, if any: back to the queue, or on to review. */
export type ExitMove = "reopen" | "review";

/**
 * Foreman's records of the work: the runs on each task (who worked it, on
 * which rung, how it ended, on which commit) and the marks foreman keeps as
 * labels (failures, attempts, walls, the operator's column, diagnostics).
 * Reads join the tracker's tasks with their runs.
 *
 * The runs live in the task store's database, keyed by task id. A records
 * write that goes with a status move (closing runs as a task is released or
 * completed) runs both in one transaction on that connection: atomic because
 * `TasksTracker` writes on the same connection, which `layer` guarantees by
 * building the two from one store.
 */
export class Records extends Context.Service<Records>()("Records", {
  make: Effect.gen(function* () {
    const tracker = yield* Tracker;
    const sql = yield* SqlClient.SqlClient;

    /** Runs a records write, naming the operation in its failure. */
    const as =
      (command: string) =>
      <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, RecordsError | TrackerError> =>
        effect.pipe(
          Effect.mapError((cause) =>
            cause instanceof TrackerError
              ? cause
              : new RecordsError({
                  command,
                  detail:
                    typeof cause === "object" && cause !== null && "detail" in cause
                      ? String(cause.detail)
                      : String(cause),
                }),
          ),
        );

    /** Runs records writes and status moves as one transaction. */
    const together = <A, E>(command: string, effect: Effect.Effect<A, E>) =>
      sql.withTransaction(effect).pipe(as(command));

    /** A run write, on the store's connection and so inside the caller's transaction. */
    const onStore = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));

    /** Closes the task's open runs with these endings; `commit` is the branch tip they leave. */
    const endRuns = (
      task: string,
      endings: {
        readonly author?: Ending;
        readonly review?: Ending;
        readonly commit?: string | undefined;
      },
    ) => together(`end runs of ${task}`, onStore(closeOpenRuns(task, endings)));

    /** The tasks with their runs, oldest first. */
    const withRuns = (
      items: ReadonlyArray<TaskItem>,
    ): Effect.Effect<ReadonlyArray<Item>, RecordsError | TrackerError> =>
      onStore(runsOf(items.map((item) => item.id))).pipe(
        Effect.map((byTask) =>
          items.map((item): Item => ({ ...item, runs: byTask.get(item.id) ?? [], tip: undefined })),
        ),
        as("read runs"),
      );

    /** Drops every label of the named kinds, whatever value each carries, then adds `added`. */
    const replaceKinds = (task: string, kinds: ReadonlyArray<string>, ...added: Array<string>) =>
      tracker
        .relabel(task, (labels) => [
          ...labels.filter((label) => !kinds.includes(kindOf(label))),
          ...added,
        ])
        .pipe(Effect.asVoid);

    /** Drops the attempt count of one rung, leaving every other rung's alone, then adds `added`. */
    const replaceAttempts = (task: string, rung: string, added: string) =>
      tracker
        .relabel(task, (labels) => [
          ...labels.filter((label) => attemptFor(label, rung) === undefined),
          added,
        ])
        .pipe(Effect.asVoid);

    /**
     * One task, or nothing when the tracker has no such task.
     *
     * "There is no such task" is an answer about the world, not a failure to
     * read it, and the two must not collapse: a workspace whose task was
     * deleted is residue to surface, while a tracker that would not answer says
     * nothing at all and must leave the workspace alone.
     */
    const lookup = (task: string) =>
      tracker.lookup(task).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<Item>()),
            onSome: (item) => withRuns([item]).pipe(Effect.map(([found]) => Option.some(found!))),
          }),
        ),
      );

    /** One task, failing when the tracker has no such task. */
    const show = (task: string) =>
      lookup(task).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              new TrackerError({ command: `show ${task}`, detail: "no such task in the store" }),
            onSome: Effect.succeed,
          }),
        ),
      );

    /** Closes the task's open runs with these endings, `released` by default, and requeues it. */
    const releasing = (task: string, endings: Endings) =>
      onStore(
        closeOpenRuns(task, {
          author: endings.author ?? "released",
          review: endings.review ?? "released",
        }),
      ).pipe(Effect.andThen(tracker.reopen(task)));

    /**
     * Returns a task to the queue and closes its open runs in one transaction,
     * each `released` unless `endings` names another. An exit an agent named
     * stands. A task already open stays open, and its runs still close.
     *
     * A reviewer that is over and a task that is open is exactly the shape a
     * rejection leaves, so a review run left open on a requeued task would
     * make the settle loop climb a rung for a rejection nobody gave. Closed,
     * the run is not the task's reviewer.
     */
    const release = (task: string, endings: Endings = {}) =>
      together(`release ${task}`, releasing(task, endings));

    /** The items that belong to one epic. */
    const children = (epic: string) =>
      tracker.list({ parent: epic }).pipe(Effect.flatMap(withRuns));

    /**
     * One project's tasks in a given status.
     *
     * Tasks only. An epic is a container that stays `in_progress` for as long
     * as it has children, so an unfiltered status query returns every epic in
     * the backlog as an ancient claim with no worker behind it — and the sweep
     * dutifully hands them all back.
     */
    const byStatus = (project: string, status: "in_progress" | "reviewing" | "done") =>
      tracker.list({ project, status, type: "task" }).pipe(Effect.flatMap(withRuns));

    return {
      show,
      lookup,

      /** A task with its log, for a reader showing it whole. */
      detail: (task: string) =>
        Effect.all([lookup(task), tracker.logs(task)]).pipe(
          Effect.map(([item, logs]) =>
            Option.map(item, (found): TaskDetail => ({ ...found, logs })),
          ),
        ),

      /** Unblocked, unclaimed tasks, in every project or in one. */
      ready: (project: Option.Option<string>) =>
        tracker.ready(Option.getOrUndefined(project)).pipe(Effect.flatMap(withRuns)),

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
        tracker.list({ status: "in_progress", type: "epic" }).pipe(
          Effect.flatMap(withRuns),
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
       * The tracker has no limit, so the caller filters this to recent work by
       * `lastActivityAt`; nothing above this file decides what "recent" is.
       */
      landed: (project: string) => byStatus(project, "done"),

      /** Claimed tasks in one project, carrying the timestamps a sweep needs. */
      claimed: (project: string) => byStatus(project, "in_progress"),

      children,

      /**
       * Records which rung of the ladder did the work, so review can pick the
       * next, and opens the author run.
       *
       * A task can be attempted more than once, and its next author starts a
       * new lap (`lap.ts`): everything the last reviews said goes out of scope
       * with no code that clears it. The run carries its own correction count, so
       * a new author starts at none.
       *
       * Claims the task in the same transaction, so a claimed task always has
       * its author run. A task already claimed, such as one whose author
       * vanished, stays claimed.
       */
      attribute: (task: string, run: NewRun) =>
        together(
          `attribute ${task}`,
          tracker.claim(task).pipe(Effect.andThen(onStore(openRun(run))), Effect.asVoid),
        ),

      /**
       * Records how a check block's command ended on the commit it ran on. A
       * check opens no run, so nothing has to close one.
       */
      recordCheck: (check: CheckRun) =>
        onStore(recordCheck(check)).pipe(as(`record check ${check.node} on ${check.task}`)),

      /**
       * Counts one more correction round sent to the current author, and
       * answers the new count.
       */
      countRound: (task: string) => onStore(addRound(task)).pipe(as(`count round ${task}`)),

      /**
       * Names the exit that ends the task's open agent run, with the commit it
       * is named on and the status move it makes, in one transaction.
       */
      nameExit: (
        task: string,
        exit: { readonly name: string; readonly commit: string | undefined },
        move: ExitMove | undefined,
      ) =>
        together(
          `name exit ${exit.name} on ${task}`,
          onStore(recordExit(task, exit)).pipe(
            Effect.andThen(move === undefined ? Effect.void : tracker[move](task)),
          ),
        ),

      /**
       * Puts a reviewer on the task: opens its review run at the branch tip it
       * reads, and closes the author's run in one transaction. An author that
       * named no exit is closed `done` at that same tip: its task reached review,
       * which is the move `done` makes. The author's work is what the reviewer reads. A review
       * run still open belongs to a reviewer this one replaces, such as one that
       * vanished; it ends `released`, which charges its rung nothing.
       */
      assignReview: (task: string, run: NewRun) =>
        together(
          `assign review ${task}`,
          onStore(
            closeOpenRuns(task, { author: "done", review: "released", commit: run.commit }),
          ).pipe(Effect.andThen(onStore(openRun(run)))),
        ),

      /**
       * Ends the task's open review run with a reason the reviewer did not
       * state itself; an exit the reviewer named stands.
       */
      endReview: (task: string, ending: Ending) => endRuns(task, { review: ending }),

      /** Closes the task's open runs that have an ending here, keeping the endings agents wrote. */
      endRuns,

      /**
       * Takes back a dispatch whose agent never started: deletes the open run
       * of that role, and for an author returns the task to the queue in the
       * same transaction. The agent never ran, so the run never happened.
       */
      abandon: (task: string, role: Role) =>
        together(
          `abandon ${role} of ${task}`,
          onStore(deleteOpenRunOf(task, role)).pipe(
            Effect.andThen(role === "author" ? tracker.reopen(task) : Effect.void),
          ),
        ),

      release,

      /**
       * Releases the task, as `release` does, and parks it in the operator's
       * column, in one transaction: whatever the ladder would say, a person
       * decides what comes next.
       */
      park: (task: string, endings: Endings = {}) =>
        together(
          `park ${task}`,
          releasing(task, endings).pipe(Effect.andThen(tracker.label(task, NEEDS_YOU))),
        ),

      /**
       * Marks work complete after foreman has landed its branch, and closes the
       * task's runs in the same transaction: the reviewer's keeps its exit,
       * and the lap's author run becomes `committed` (`answered` for research).
       * Done first, so a task that cannot be completed fails on `done` itself.
       * A wall label left on a done task is inert: nothing dispatches it.
       */
      complete: (task: Pick<Item, "id" | "labels">) =>
        together(
          `done ${task.id}`,
          tracker
            .complete(task.id)
            .pipe(
              Effect.andThen(
                onStore(closeOpenRuns(task.id, { author: "released", review: "released" })),
              ),
              Effect.andThen(onStore(landAuthorRun(task.id, isResearch(task)))),
              Effect.andThen(replaceKinds(task.id, [WALLED])),
            ),
        ),

      /** Records that the task's agent stopped on this account's usage wall. */
      markWall: (task: string, provider: string) => tracker.label(task, `${WALLED}:${provider}`),

      /**
       * Records that a rung was tried on this task and was not enough.
       *
       * Durable rather than in foreman's memory, because this is exactly what
       * the next dispatch — possibly days later, possibly after a restart —
       * reads to decide which model gets the work. It names the rung that
       * failed, never the one that runs next: what runs next depends on which
       * rungs are configured and paid for at the moment of dispatch, and a task
       * that stated that in advance would be stranded by a config edit or a
       * spent account.
       *
       * The rung's attempt count goes with it. The count exists to decide when
       * the rung is spent; once it is spent, the count has been read for the
       * last time, and leaving it behind would let a task lowered back onto
       * that rung inherit a verdict it has not earned again.
       */
      markFailure: (task: string, rung: string) =>
        replaceAttempts(task, rung, `${FAILED_BY}:${rung}`),

      /**
       * Writes how many times the named rung has stopped on the task without an exit.
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
        tracker
          .relabel(task, (labels) => labels.filter((label) => valueOf(label, FAILED_BY) !== rung))
          .pipe(Effect.asVoid),

      /** Puts a task a person parked back in the queue at the rung it had earned. */
      clearNeedsYou: (task: string) => tracker.unlabel(task, NEEDS_YOU),

      markDiagnostic: (task: string, intent: DiagnosticIntent) =>
        replaceKinds(task, [DIAGNOSING], `${DIAGNOSING}:${intent}`),

      clearDiagnostic: (task: string) => replaceKinds(task, [DIAGNOSING]),
    } as const;
  }),
}) {
  /**
   * Records and the tasks tracker over one store connection, which the caller
   * provides once. Both services come out, and they share that connection,
   * which is what makes `together` atomic across them.
   */
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provideMerge(TasksTracker));
}

/** An epic being driven, and its direct children: how close it is to done. */
export interface EpicProgress {
  readonly epic: Item;
  readonly children: ReadonlyArray<Item>;
}

/** One task as a reader shows it whole: the item and its log. */
export interface TaskDetail extends Item {
  readonly logs: ReadonlyArray<LogEntry>;
}

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

/**
 * Whether a task's deliverable is a report rather than code.
 *
 * The report lives in the task's own log, so the branch is legitimately empty
 * and the reviewer reads evidence instead of a diff. `research` is set when the
 * task is filed and survives every attempt, unlike the `already-done` exit, which is the
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
 * Not derivable from the author run. A task pinned by hand has never been authored and
 * has no author run to read at all, and who authored last does not say who
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
 * How many times the named rung has stopped on the task without an exit.
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

/**
 * How big a slice is, as the coordinator judged it when filing: `size:1` one
 * file or rule, `size:2` one package, `size:3` crosses packages. Larger is
 * allowed. An integer, so the trials record can compare sizes by order.
 */
export const SIZE = "size";

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

/** Prefix of the label counting a rung's stopped attempts: `attempt:<rung>:<n>`. */
export const ATTEMPT = "attempt";

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

export class RecordsError extends S.TaggedError<RecordsError>()("RecordsError", {
  command: S.String,
  detail: S.String,
}) {
  override get message() {
    return `${this.command}: ${this.detail}`;
  }
}
