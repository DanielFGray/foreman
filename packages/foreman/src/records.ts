import { Context, Effect, Layer, Option, Schema as S } from "effect";
import { SqlClient } from "effect/sql";
import {
  addRound,
  charge,
  chargesOf,
  closeOpenRuns,
  deleteOpenRunOf,
  forgive,
  landAuthorRun,
  openRun,
  park,
  parksOf,
  recordCheck,
  recordExit,
  runsOf,
  lastStarts,
  unpark,
  type Charge,
  type Ending,
  type Item as TaskItem,
  type LogEntry,
  type Role,
  type Run,
} from "tasks";
import type { AgentIdentity, AgentRole } from "./fleet.ts";
import { providerOf, type Seat } from "./ladder.ts";
import { seatOf, type Seats } from "./reviewers.ts";
import type { Row } from "./run-step.ts";
import { ProjectTracker, Tracker, TrackerError } from "./tracker.ts";

export type { Status as TaskStatus } from "tasks";

/**
 * A task as foreman reads it: the tracker's item, the runs on it oldest first,
 * the rungs charged with failing it, whether it is parked for the operator,
 * and the tip of its branch.
 *
 * The tip is not in the store. The dispatcher's observation stamps it from git,
 * because an approval is bound to the commit the reviewer read (`lap.ts`); a
 * task read any other way has none.
 */
export interface Item extends TaskItem {
  readonly runs: ReadonlyArray<Run>;
  readonly charges: ReadonlyArray<Charge>;
  /** Why the task is parked for the operator; empty when it is not. */
  readonly parked: string | undefined;
  readonly tip: string | undefined;
}

/** The endings a release closes a task's open runs with, per role. */
export interface Endings {
  readonly author?: Ending;
  readonly review?: Ending;
}

/**
 * Foreman's records of the work: the runs on each task (who worked it, on
 * which rung, how it ended, on which commit), the rungs charged with failing
 * it, and the tasks parked for the operator. Reads join the tracker's tasks
 * with these records; the one label foreman still writes is a diagnostic
 * intervention's.
 *
 * The records live in the task store's database, keyed by task id, so a
 * tracker carries only task state. A records
 * write that goes with a status move (closing runs as a task is released or
 * completed) runs both in one transaction on that connection. This is atomic
 * only for a prog project, whose `TasksTracker` writes on the same connection,
 * which `layer` guarantees by building the two from one store.
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

    /** The tasks with their runs and charges, oldest first, and their parks. */
    const withRuns = (
      items: ReadonlyArray<TaskItem>,
    ): Effect.Effect<ReadonlyArray<Item>, RecordsError | TrackerError> => {
      const ids = items.map((item) => item.id);
      return onStore(Effect.all([runsOf(ids), chargesOf(ids), parksOf(ids)])).pipe(
        Effect.map(([runs, charges, parks]) =>
          items.map((item): Item => ({
            ...item,
            runs: runs.get(item.id) ?? [],
            charges: charges.get(item.id) ?? [],
            parked: parks.get(item.id),
            tip: undefined,
          })),
        ),
        as("read runs"),
      );
    };

    /** Drops every label of the named kinds, whatever value each carries, then adds `added`. */
    const replaceKinds = (task: string, kinds: ReadonlyArray<string>, ...added: Array<string>) =>
      tracker
        .relabel(task, (labels) => [
          ...labels.filter((label) => !kinds.includes(kindOf(label))),
          ...added,
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
    const byStatus = (project: string, status: "in_progress" | "done") =>
      tracker.list({ project, status, type: "task" }).pipe(Effect.flatMap(withRuns));

    return {
      show,
      lookup,

      /**
       * Writes one row of the joint table (`stepOf` in `run-step.ts`) in one
       * transaction. The records go first and the status move last, because a
       * tracker may share no transaction with them: a landing whose completion
       * fails then leaves a claimed task with a landed author run, and the next
       * landing finds the branch in the checkout and completes it. Charges go
       * after a check run and before a new run, because a charge records the
       * newest run on the task when it is written.
       */
      write: (task: string, row: Row) =>
        together(
          `write ${task}`,
          Effect.gen(function* () {
            if (row.close !== undefined) yield* onStore(closeOpenRuns(task, row.close));
            if (row.exit !== undefined) yield* onStore(recordExit(task, row.exit));
            if (row.check !== undefined) yield* onStore(recordCheck(row.check));
            for (const rung of row.charges) yield* onStore(charge(task, rung));
            if (row.park !== undefined) yield* onStore(park(task, row.park));
            if (row.open !== undefined) yield* onStore(openRun(row.open));
            if (row.land !== undefined)
              yield* onStore(landAuthorRun(task, row.land === "answered"));
            if (row.move === "complete") yield* tracker.complete(task);
            if (row.move === "claim") yield* tracker.claim(task);
            if (row.move === "reopen") yield* tracker.reopen(task);
          }),
        ),

      /**
       * The latest start of each seat, per role: the turn order of the rungs
       * inside a level (`authorFor`) and of the reviewers (`reviewerFor`).
       */
      lastStarts: onStore(
        Effect.all({ author: lastStarts("author"), review: lastStarts("review") }),
      ).pipe(as("read run starts")),

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

      /**
       * Claimed tasks in one project. A task under review is still
       * `in_progress`; the dispatcher splits the list by placement.
       */
      claimed: (project: string) => byStatus(project, "in_progress"),

      children,

      /**
       * Counts one more correction round sent to the current author, and
       * answers the new count.
       */
      countRound: (task: string) => onStore(addRound(task)).pipe(as(`count round ${task}`)),

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
      park: (task: string, reason: string, endings: Endings = {}) =>
        together(
          `park ${task}`,
          onStore(park(task, reason)).pipe(Effect.andThen(releasing(task, endings))),
        ),

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
       * The charge also ends the rung's attempt count (`attemptsOf`): the count
       * decides when the rung is spent, and a task lowered back onto that rung
       * must not inherit a verdict it has not earned again.
       */
      markFailure: (task: string, rung: string) =>
        onStore(charge(task, rung)).pipe(as(`charge ${rung} on ${task}`)),

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
        onStore(forgive(task, rung)).pipe(as(`forgive ${rung} on ${task}`)),

      /** Puts a parked task back in the queue at the rung it had earned. */
      unpark: (task: string) => onStore(unpark(task)).pipe(as(`unpark ${task}`)),

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
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provideMerge(ProjectTracker));
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
export const agentLog = (role: AgentRole, rung: Seat, agent: AgentIdentity): string =>
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
 * picks a rung from the lowest level above theirs that is available now. Evidence rather
 * than a pointer, so retiring a model or spending its allowance moves the work
 * on instead of naming a rung nothing can dispatch.
 *
 * Not derivable from the author run. A task pinned by hand has never been authored and
 * has no author run to read at all, and who authored last does not say who
 * authors next: a reviewer's rejection fails the rung, while an agent that
 * stopped without finishing leaves it standing until its attempts run out.
 */
export const failuresOf = (item: {
  readonly charges: ReadonlyArray<Charge>;
}): ReadonlyArray<string> => [
  ...new Set(item.charges.filter((one) => !one.forgiven).map((one) => one.rung)),
];

/**
 * Whether the task is parked for the operator, whatever the ladder would say.
 *
 * The one durable way into the operator's column. Everything else there is
 * derived from the failures and the config, so it clears itself when a rung is
 * added or an allowance resets; this one is a decision and only a decision
 * removes it.
 */
export const needsYou = (item: { readonly parked: string | undefined }): boolean =>
  item.parked !== undefined;

/**
 * How many author runs on the named rungs ended without an exit (`stopped` or
 * `vanished`) since any of them was last charged.
 *
 * The escalation passes a whole level (`levelPeers`), because peers share the
 * work and so share its count. `0` when none of the rungs has been tried, or
 * when every such run came before a charge: a charge ends the count. The count
 * is what the escalation reads on a dispatch days later.
 */
export const attemptsOf = (
  item: { readonly runs: ReadonlyArray<Run>; readonly charges: ReadonlyArray<Charge> },
  rungs: ReadonlyArray<string>,
): number => {
  const after = Math.max(
    -1,
    ...item.charges.filter((one) => rungs.includes(one.rung)).map((one) => one.run ?? -1),
  );
  return item.runs.filter(
    (run) =>
      run.role === "author" &&
      run.rung !== undefined &&
      rungs.includes(run.rung) &&
      run.id > after &&
      (run.ending === "stopped" || run.ending === "vanished"),
  ).length;
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

/** The label that marks a task as a defect in shipped code rather than new work. */
export const BUG = "bug";

export const DIAGNOSING = "diagnosing";
export const ONBOARD = "onboard";

/**
 * The label marking a task whose deliverable is a report, not code.
 *
 * Set when the task is filed and never cleared: it says what kind of work this
 * is, so an empty branch that reaches review is a report to read rather than an
 * author that wrote nothing.
 */
export const RESEARCH = "research";

/**
 * The accounts a task's agents have stopped on a usage wall: the providers of
 * the seats whose runs ended `walled` since the task last landed, an author's
 * or a reviewer's.
 *
 * A stop on a usage wall says nothing about the model, so the task is not
 * failed; the wall only keeps seats on that account off the task's next
 * dispatch. Landing ends it, because the wall describes the account at that
 * time. A seat its list no longer has names no account.
 */
export const walledBy = (
  item: { readonly runs: ReadonlyArray<Run> },
  seats: Seats,
): ReadonlyArray<string> => {
  const providers = sinceLanded(item)
    .filter((run) => run.ending === "walled")
    .flatMap((run) => {
      const seat = seatOf(seats, run);
      const provider = seat === undefined ? undefined : providerOf(seat);
      return provider === undefined ? [] : [provider];
    });
  return [...new Set(providers)];
};

/**
 * The task's runs after the author run foreman last landed, oldest first: the
 * work on it since it was last done. A task never landed has all its runs.
 */
export const sinceLanded = (item: { readonly runs: ReadonlyArray<Run> }): ReadonlyArray<Run> => {
  const landed = Math.max(-1, ...item.runs.filter((run) => run.landed).map((run) => run.id));
  return item.runs.filter((run) => run.id > landed);
};

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
