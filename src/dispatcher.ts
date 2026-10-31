import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Match,
  Metric,
  Option,
  Queue,
  Ref,
  SubscriptionRef,
  Layer,
} from "effect";
import { Settings } from "./config.ts";
import {
  type AgentRole,
  type CloseOptions,
  directoryFor,
  Fleet,
  labelFor,
  type SpawnOptions,
  taskOf,
  verifyDirectoryFor,
  type Worker,
} from "./fleet.ts";
import { Prompts } from "./prompt.ts";
import { pinnedFirst, pinnedOf } from "./pin.ts";
import { phaseOf, type TaskPhase } from "./task-phase.ts";
import { Repository, RepositoryError, type Hold, type HoldReason } from "./repository.ts";
import { Quota, type Usage, walledRungs } from "./quota.ts";
import {
  authorFor,
  dispatchable as dispatchableRungs,
  rankOf,
  type Choice,
  highestFailure,
  providersOf,
  providerOf,
  reviewerFor,
  type Rung,
  rungSpent,
  rungsOn,
  topOf,
} from "./ladder.ts";
import {
  agentLog,
  attemptsOf,
  authoredBy,
  diagnosticIntent,
  type DiagnosticIntent,
  isApproved,
  isPinned,
  isOnboarding,
  isResearch,
  isSatisfied,
  type Item,
  failuresOf,
  needsYou,
  ONBOARD,
  Prog,
  type ReadyTask,
  reviewedBy,
} from "./prog.ts";
import { Trials, trialFor } from "./trials.ts";

const runDuration = Metric.timer("foreman.run.duration", {
  description: "Time foreman spends dispatching one run, in milliseconds.",
  boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 20 }),
});

const runOutcomes = Metric.counter("foreman.run.outcomes", {
  description: "Settled agent runs by their closed task phase.",
  incremental: true,
});

/**
 * The loop that replaces the human, and the commands a dashboard can give it.
 *
 * Foreman remembers nothing between ticks. What it is doing is read back every
 * time from the multiplexer's workspaces and the task store, because a
 * dispatcher whose memory is authoritative loses the fleet when it restarts —
 * and this one restarts whenever its dashboard is closed. Everything the loop
 * decides is therefore derivable by anyone else looking at the same world.
 */
export class Dispatcher extends Context.Service<Dispatcher>()("Dispatcher", {
  make: Effect.gen(function* () {
    const settings = yield* Settings;
    const fleet = yield* Fleet;
    const prog = yield* Prog;
    const prompts = yield* Prompts;
    const repository = yield* Repository;
    const quota = yield* Quota;
    const trials = yield* Trials;

    const runAttributes = (
      task: {
        readonly id: string;
        readonly project: string;
        readonly labels: ReadonlyArray<string>;
      },
      rung: Rung,
      role: AgentRole,
    ) => ({
      task: task.id,
      project: task.project,
      rung: rung.name,
      model: rung.model ?? rung.harness,
      role,
      attempt: attemptsOf(task, rung.name) + 1,
      labels: task.labels.join(","),
    });

    const instrumentRun = <A, E, R>(
      task: {
        readonly id: string;
        readonly project: string;
        readonly labels: ReadonlyArray<string>;
      },
      rung: Rung,
      role: AgentRole,
      effect: Effect.Effect<A, E, R>,
    ) => {
      const attributes = runAttributes(task, rung, role);
      const duration = Metric.withAttributes(runDuration, { rung: rung.name });
      return Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        return yield* effect.pipe(
          Effect.tap(() => Effect.annotateCurrentSpan(attributes)),
          Effect.ensuring(
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((ended) => Metric.update(duration, Duration.millis(ended - started))),
            ),
          ),
        );
      });
    };

    // The one piece of genuinely non-derivable state: how much work the
    // operator has asked foreman to take on. Nothing in the world records an
    // intention.
    //
    // Three states out of one value rather than a boolean and a flag beside
    // it. `paused` observes and reports the world but does not settle, tidy,
    // reclaim or fill it. `draining` runs everything except the author pass,
    // so reviews, landings and the sweep empty the pipeline while nothing new
    // enters it — which is what aiming the fleet by hand needs, and what a
    // plain pause cannot give: pause stops landing too, so it strands work a
    // reviewer already approved.
    //
    // It starts paused unless the operator said otherwise on the command line.
    // The operator who opened the screen to drain the fleet therefore gets a
    // quiet first tick rather than racing it to pause.
    //
    // `--running` is how a restart inherits the answer. Under `bun --watch` the
    // daemon restarts whenever foreman's own source changes — which includes
    // landing a task into foreman's own checkout — so pausing by default parked
    // the fleet after every landing and waited for a person. The command line is
    // the only thing a restart carries over, which is why the intention is
    // stated there and nowhere durable: recording it would make foreman
    // remember, and the operator's last keypress is not a fact about the world.
    const dispatch = yield* Ref.make<Dispatch>(settings.running ? "running" : "paused");
    const state = yield* SubscriptionRef.make(empty);

    // The second piece of in-process state, kept for the same reason as
    // `paused`: the world does not record foreman's own attempts. A dispatch
    // failure is only observed by trying, and the trying is what must stop —
    // the worktree that made `open` fail will still exist next tick, so a
    // second attempt learns nothing. Two identical failures move the task to a
    // decision instead of a third attempt. A restart forgets the tally, which
    // costs the daemon two attempts to relearn it; the tasks themselves stay
    // safe in the queue either way.
    const dispatchFailures = yield* Ref.make(new Map<string, DispatchFailure>());

    // Whether anyone is reading the accounts. Not a fact about the world and
    // not an intention either — it is who is listening, which only the screen
    // in front of the operator knows and nothing durable could record. A
    // paused fleet with nobody on the quota view has no consumer for an
    // allowance, and a reading nobody consults is a network request per poll
    // spent on nothing. It resets to false on a restart, which is correct: no
    // screen survives the process, so nobody is watching until one says it is.
    const watchingQuota = yield* Ref.make(false);

    // Whether the accounts have been read at all yet. A fleet that has just
    // started has nothing to say about them, and "no reading" and "nothing
    // left" are not distinguishable on a dashboard — so the first tick asks
    // whatever the fleet is doing, and a paused one then stops. One probe per
    // process, which is also what makes a restart show the accounts without
    // the operator having to unpause to see them.
    const everProbed = yield* Ref.make(false);

    // The poll interval is how long foreman waits to notice something nobody
    // told it about. An operator pressing a key told it, so that case has no
    // reason to wait at all — the loop takes whichever arrives first. Sliding
    // and one deep: a burst of keystrokes means one tick, not a backlog of
    // them, because each tick already reads the whole world.
    const wake = yield* Queue.sliding<void>(1);
    const nudge = Queue.offer(wake, undefined).pipe(Effect.asVoid);

    /** Runs an operator's command, then lets the loop see what it changed. */
    const commanded = <A, E, R>(command: Effect.Effect<A, E, R>) =>
      command.pipe(Effect.tap(() => nudge));

    /**
     * Records a dispatch failure against its task, and says so in the log once
     * per failure rather than once per tick.
     *
     * The first failure is news and is logged. The second identical failure is
     * a decision: logged once with the count, and from there the task is held
     * out of the queue and surfaced in decisions. A different failure resets
     * the tally, because it is a new fact rather than a repeat.
     */
    const recordFailure = (task: string, error: unknown) =>
      Ref.modify(dispatchFailures, (current) => {
        const detail = String(error);
        const { failures: next, count, report } = nextFailure(current, task, detail);
        const log =
          report === "first"
            ? Effect.logWarning(`dispatching ${task} failed: ${detail}`)
            : report === "repeat"
              ? Effect.logWarning(
                  `dispatching ${task} failed ${count} times: ${detail} — stopped retrying; retry once the cause is cleared`,
                )
              : Effect.void;
        return [log, next] as const;
      }).pipe(Effect.flatten);

    /** Forgets a task's dispatch failures, so a retry starts the tally over. */
    const clearFailure = (task: string) =>
      Ref.update(dispatchFailures, (current) => {
        if (!current.has(task)) return current;
        const next = new Map(current);
        next.delete(task);
        return next;
      });

    /**
     * Reads the world once and publishes it, acting on nothing.
     *
     * The first half of every tick, and the whole of what a one-shot command
     * needs before it acts on a row: the command line holds no dashboard, so
     * this is how it learns which rows exist.
     */
    const read = Effect.gen(function* () {
      // Read once and handed to both readings. A tick observes twice — before
      // it acts, and again on fresh eyes before it fills — while an allowance
      // moves on the order of hours, so asking each provider twice a poll
      // would be a request every few seconds for a number that cannot have
      // changed between them.
      //
      // Forked rather than awaited, because it is the slowest read in the tick
      // and the last one any decision needs: a provider is asked over the
      // network, while everything below is a local store or a git checkout.
      // Waiting for it first is the tick standing still for as long as the
      // slowest account takes to answer. It is still this tick's reading — the
      // join is before anything interprets it — so nothing is decided from a
      // probe that finished during an earlier tick.
      //
      // Asked at all only where the answer has a consumer. A paused fleet
      // dispatches nothing, so no gate reads an allowance, and the spent
      // accounts in attention are not what stopped it — the operator is, and
      // the status line already says so. Probing on regardless is a network
      // request every poll to explain a halt that has another cause. The
      // operator looking at the quota view is the other consumer, and it says
      // so through `quota` rather than by being guessed at here.
      const mode = yield* Ref.get(dispatch);
      const wanted =
        mode !== "paused" || (yield* Ref.get(watchingQuota)) || !(yield* Ref.get(everProbed));
      if (wanted) yield* Ref.set(everProbed, true);
      const probing = yield* Effect.forkChild(
        wanted ? readProviders : Effect.succeed<ReadonlyArray<Provider>>([]),
      );
      const observation = yield* observe;
      // A tick that did not ask carries the last answer rather than publishing
      // an empty set, because "not read" and "no accounts" look identical on a
      // dashboard and only one of them is true. Carried for the view alone:
      // the gate that reads an allowance runs only when the fleet is not
      // paused, and a fleet that is not paused probes on every tick, so no
      // dispatch is ever decided from a reading this line kept.
      const previous = yield* SubscriptionRef.get(state);
      const providers = wanted ? yield* Fiber.join(probing) : previous.providers;

      const current = yield* interpret(observation, providers);
      yield* SubscriptionRef.set(state, current);
      return { mode, current, providers };
    });

    /**
     * Reads the whole world and works out what to do about it.
     *
     * Order matters. Reviews are dispatched before new work because a task
     * waiting to be reviewed is nearly finished and is blocking whatever
     * depends on it, whereas an unclaimed task has not started costing
     * anything yet. Filling slots with new work while reviews pile up is how a
     * queue grows a permanent tail of almost-done tasks.
     */
    const tick = Effect.gen(function* () {
      const { mode, current, providers } = yield* read;
      if (mode === "paused") return;
      yield* settle(current);
      yield* tidy(current);
      yield* reclaim(current);
      yield* recover(current);
      // The second reading is narrow, not stale. The passes above write to the
      // store and to git, so what fill decides from has to be read after them —
      // but a dispatch turns on ten fields, and the columns only a person reads
      // cost a `prog show` per branch and a `git status` per worktree to build.
      // Reading them again here would be work whose one consumer is the
      // discard.
      yield* fill(yield* readDispatch(providers), mode);
    }).pipe(Effect.withSpan("foreman.tick"));

    /**
     * What each account behind the ladder has left of its allowance.
     *
     * A provider foreman could not read is carried to the dashboard but never
     * counted as spent: an unreachable usage endpoint is foreman's own network
     * trouble, and stopping the fleet on it would be the opposite of what the
     * gate is for. Its rungs stay dispatchable and an agent meets the wall
     * itself, which is exactly where the fleet stood before any of this was
     * read.
     */
    const readProviders = Effect.forEach(
      providersOf(settings.ladder),
      (provider) =>
        quota.usage(provider).pipe(
          Effect.map((usage): Provider => ({
            provider,
            plan: usage.plan,
            allowances: usage.allowances,
            rungs: rungsOn(settings.ladder, provider),
            unreadable: undefined,
          })),
          Effect.catch((error) =>
            (error.permanent
              ? // A permanent failure — an account with no usage source, a
                // missing credential, an expired token — repeats on every poll,
                // so it is carried to the dashboard and never logged. Only a
                // transient one, which may clear by itself, is worth a line.
                Effect.void
              : Effect.logWarning(`quota unreadable for ${provider}: ${error.detail}`)
            ).pipe(
              Effect.as<Provider>({
                provider,
                plan: undefined,
                allowances: [],
                rungs: rungsOn(settings.ladder, provider),
                unreadable: error.detail,
              }),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );

    /**
     * One reading of the world, holding only what every consumer of it needs.
     *
     * The tick reads twice — the passes between the two write to the store and
     * to git, so what fill decides from must be read after them — and this is
     * the part both readings pay for. Everything here gates a dispatch: `held`
     * passes a project over, `branches` says which reviews have a diff behind
     * them, and the focus scope decides the reserved slot. The columns that
     * only a person looks at are read in `interpret` instead, so the second
     * reading does not pay for them.
     */
    const observe = Effect.gen(function* () {
      // The roster is every daemon's: the fleet lists every task's workers
      // whoever started them, and a label records no ownership — two
      // foremen against different configs are not competing for the same
      // slots. The checkout a workspace's worktree belongs to is what the
      // config's project set scopes, and the fleet reports it, so ownership is
      // settled before the store is asked anything. Scoping by the task's
      // project instead means one `prog show` per workspace on the machine
      // before knowing whether any of them is this daemon's — and it cannot
      // classify a workspace whose task has been deleted at all.
      const managed = new Set(settings.projects.map((project) => project.name));
      const roster = ours(
        yield* fleet.roster,
        new Set(settings.projects.map((project) => project.directory)),
      );

      // Every workspace's task, read once. The roster is joined to the store
      // rather than filtered through status queries, because a task leaves a
      // column's status at the exact moment it moves to another — the durable
      // join is what lets work that has reached a terminal state still be
      // settled.
      //
      // A store that would not answer is not an answer: the workspace is left
      // out of this reading entirely and the next tick asks again. Only
      // `lookup` returning nothing is a fact, and it makes the workspace an
      // orphan below.
      const readings = yield* Effect.forEach(roster, (worker) =>
        prog.lookup(worker.task).pipe(
          Effect.map((task) => [{ worker, task }] as const),
          Effect.catch((error) =>
            Effect.logWarning(`skipped worker ${worker.task}: ${error}`).pipe(
              Effect.as<ReadonlyArray<{ worker: Worker; task: Option.Option<Item> }>>([]),
            ),
          ),
        ),
      ).pipe(Effect.map((entries) => entries.flat()));

      // Which checkouts the operator is presently working in. Read every tick
      // like everything else: you clean a tree up between two ticks and the
      // project comes back on its own. The reason rides along, because a hold
      // that clears itself and one that needs a hand-run command must not read
      // the same on the dashboard.
      const held = yield* Effect.forEach(settings.projects, (project) =>
        repository.isClean(project.directory).pipe(
          Effect.map((result: Hold): ReadonlyArray<Held> =>
            result._tag === "Clean"
              ? []
              : [{ project: project.name, reason: result.reason, detail: result.detail }],
          ),
          // A checkout foreman cannot read is a checkout it must not merge
          // into either, so an unreadable repository is held rather than free.
          Effect.catch((error: RepositoryError) =>
            Effect.logWarning(`holding ${project.name}: ${error}`).pipe(
              Effect.as<ReadonlyArray<Held>>([
                { project: project.name, reason: "unreadable", detail: error.detail },
              ]),
            ),
          ),
        ),
      ).pipe(
        Effect.map((rows) => rows.reduce<ReadonlyArray<Held>>((all, row) => [...all, ...row], [])),
      );

      const claimed = yield* eachProject((project) => prog.claimed(project.name));
      const reviewing = yield* eachProject((project) => prog.awaitingReview(project.name));
      const epics = yield* eachProject((project) =>
        prog
          .inProgressEpics(project.name)
          .pipe(
            Effect.flatMap((items) =>
              Effect.forEach(items, (epic) =>
                prog.children(epic.id).pipe(Effect.map((children) => ({ epic, children }))),
              ),
            ),
          ),
      );
      // One query, gated by prog: `ready` returns a task only once every task
      // blocking it is done, whichever project that blocker lives in. The
      // allowlist is applied afterwards, to prog's answer rather than to the
      // question, so a blocker outside the fleet still holds its dependents.
      const queue = yield* prog.ready();

      // What the operator has pinned. Derived from the `pin` label rather than
      // remembered: the dashboard writes it into prog, and the dashboard being
      // the process means a restart must re-read the same label rather than
      // lose the intention. The scope is every task at or under an item
      // carrying the label.
      const pinned = yield* pinnedOf(yield* prog.pinned(), managed, (id) => prog.children(id));

      // Foreman's branches, in every project. One read, three questions: which
      // branches nothing in the pipeline accounts for, whether a task handed
      // back for review has anything on it, and which refs the sweep may
      // delete. They were three reads once, and the answers disagreed.
      const branches = yield* eachProject((project) =>
        repository.branches(project.directory).pipe(
          Effect.map((refs) =>
            refs.flatMap((ref) => {
              const task = taskOf(ref.branch);
              return task
                ? [{ ...ref, project: project.name, directory: project.directory, task }]
                : [];
            }),
          ),
        ),
      );

      return {
        managed,
        readings,
        roster,
        held,
        claimed,
        reviewing,
        epics,
        queue,
        pinned,
        branches,
      } as const;
    });

    type Observation = Effect.Success<typeof observe>;
    type Dispatchable = ReturnType<typeof dispatchFrom>;

    /**
     * Everything one reading of the world implies, without asking it again.
     *
     * Pure, because that is what lets the narrow reading fill feeds on and the
     * wide one the dashboard draws be the same answer by construction rather
     * than by two code paths agreeing. Nothing here may reach for the store or
     * git: a value that needs another read belongs in `interpret`.
     */
    const dispatchFrom = (
      observation: Observation,
      providers: ReadonlyArray<Provider>,
      failed: ReadonlyArray<readonly [string, DispatchFailure]>,
    ) => {
      const {
        managed,
        readings,
        roster,
        held,
        claimed,
        reviewing,
        epics,
        queue,
        pinned,
        branches,
      } = observation;

      const tasks = new Map(
        readings.flatMap(({ worker, task }) =>
          Option.isSome(task) ? [[worker.task, task.value] as const] : [],
        ),
      );

      // A workspace in a project foreman manages whose task the store denies.
      // Nothing will ever be dispatched into it and no task records it, so it
      // would otherwise sit open forever — the one residue foreman can name
      // but not prove is spent, because the worktree may still hold work.
      const orphans = readings.flatMap(({ worker, task }) => (Option.isNone(task) ? [worker] : []));

      const { owned, workers } = scopeRoster(roster, tasks);
      const ownedByTask = new Map(owned.map((entry) => [entry.task.id, entry]));

      // Authorship, not availability. A branch whose commits the checkout
      // already has still proves the author wrote something — and a task in
      // review whose branch was merged by hand needs landing, not requeueing.
      const committed = new Set(
        branches.filter((entry) => !entry.empty).map((entry) => entry.task),
      );

      // A branch the trunk has overtaken, under a task still in review. The
      // branch cannot land, so the review of it cannot be applied either — the
      // review pass holds it out and the operator decides instead. Only the
      // reviewing status surfaces: an open branch will reach this same row
      // when its author hands off, and an in-progress one is being worked on
      // in a column that already shows it. Oldest first, the order the fleet
      // was about to spend on them.
      //
      // The task is joined off the review list rather than read back: only a
      // reviewing task ever survived this filter, so every row's item is one
      // the same reading already holds.
      const underReview = new Map(reviewing.map((task) => [task.id, task]));
      const stale = branches
        .flatMap(({ stale, project, branch, task }) => {
          if (stale === undefined) return [];
          const item = underReview.get(task);
          return item === undefined
            ? []
            : [
                {
                  project,
                  branch,
                  task: item,
                  paths: stale.paths,
                  modifyDelete: stale.modifyDelete,
                } satisfies StaleRow,
              ];
        })
        .sort(
          (first, second) =>
            first.task.last_activity_at.getTime() - second.task.last_activity_at.getTime(),
        );

      // What the sweep may delete: a merged ref for work nothing in the
      // pipeline is still pointing at. The branch is a task's only proof that
      // its author wrote anything, and a merge can arrive from outside foreman
      // — a hand-merged branch swept on the tick before its reviewer settles
      // leaves that task looking like one nobody ever committed to. A task the
      // fleet still accounts for is never swept: the queue will dispatch onto
      // that same branch, and a claim with no worker is already a decision the
      // operator is being asked about.
      const accounted = new Set([...claimed, ...reviewing, ...queue].map((task) => task.id));
      const prunable = branches.filter(
        (entry) => entry.merged && !accounted.has(entry.task) && !ownedByTask.has(entry.task),
      );

      // Which rungs have no allowance left. An author's rung is chosen from
      // what the task records as having failed it, so this is read before the
      // queue is split: a spent account changes which rung a task gets, and at
      // the top of the ladder whether it can be dispatched at all.
      const walled = walledRungs(providers);
      const choiceFor = (task: { readonly labels: ReadonlyArray<string> }): Choice =>
        authorFor(settings.ladder, failuresOf(task), walled);

      // Work waiting on the operator is ready by every measure prog knows and
      // still must not be dispatched: it is waiting on a decision no agent can
      // make. Split here rather than in fill, so the dashboard can say where it
      // went instead of leaving it to look like a queue that stopped moving.
      //
      // A task waiting on an allowance is not one of these. That is a fact
      // about a wallet, it clears itself when the account resets, and handing
      // it to the operator would ask them to decide something no decision
      // changes — so it stays in the queue, marked, and `outOfQuota` holds it
      // back from a dispatch.
      const parked = (task: { readonly labels: ReadonlyArray<string> }) =>
        needsYou(task) || choiceFor(task)._tag === "Yours";
      const dispatchable = queue.filter((task) => !parked(task));
      const failedIds = new Set(failed.map(([task]) => task));

      const active = (items: ReadonlyArray<Item>) =>
        items.map(
          (task) =>
            ownedByTask.get(task.id) ?? {
              task,
              worker: undefined,
              kind: reviewedBy(task) ?? authoredBy(task),
            },
        );

      // One mapping, three columns. working and review each take a slice of
      // these, and decisionsOf reads the vanished-worker rows off the same
      // arrays rather than mapping the lists a second time.
      const claimedActive = active(claimed);
      const reviewingActive = active(reviewing);

      const autoWork = dispatchable.filter((task) => !isOnboarding(task));

      // How close each task's own epic is to done, for the ones whose epic is
      // not itself pinned. A pinned epic's children already lead absolutely;
      // stacking a completion credit on top of that would only reorder a group
      // that outranks everything else regardless.
      const epicCompletion = new Map<string, number>();
      for (const { epic, children } of epics) {
        if (epic.labels.includes("pin") || children.length === 0) continue;
        const fraction =
          children.filter((child) => child.status === "done").length / children.length;
        for (const child of children) epicCompletion.set(child.id, fraction);
      }
      const epicFractionOf = (task: { readonly id: string }) => epicCompletion.get(task.id) ?? 0;

      // Pinned work leads, then everything else, each half ordered by the same
      // rules the whole queue always used. A pin changes where work sits in
      // one list; it reserves no slot and stops nothing, so the projects both
      // halves rotate between stay every managed project.
      const ordered = pinnedFirst(
        excludeFailedTasks(autoWork, failed),
        pinned,
        [...managed],
        epicFractionOf,
      );

      // Which tasks their next agent could not be paid for. A task's rung
      // depends on the column it is in — an author's is the cheapest available
      // rung above its failures, a review's is the rung above whoever wrote it
      // — and the columns are disjoint, so one set of task ids says it for both
      // without ambiguity.
      const reviews = reviewable(reviewingActive, committed);
      const outOfQuota = new Set([
        ...ordered.filter((task) => choiceFor(task)._tag === "Waiting").map((task) => task.id),
        // A review is gated only when no rung at or above the reviewer's can be
        // paid for. `reviewerFor` answers that by returning nothing, and the
        // dispatch resolves the rung the same way from the same reading, so the
        // gate cannot pass over a task the dispatch would have found an agent
        // for, nor the reverse.
        ...reviews.review
          .filter(
            ({ task }) => reviewerFor(settings.ladder, authoredBy(task), walled) === undefined,
          )
          .map(({ task }) => task.id),
      ]);

      return {
        workers,
        owned,
        held,
        orphans,
        providers,
        outOfQuota,
        // Salvage runs stand in a directory a person is using, so they start
        // when that person asks and never because a slot came free.
        queue: ordered,
        epics,
        yours: queue.filter((task) => parked(task) && managed.has(task.project)),
        working: claimedActive,
        ...reviews,
        committed,
        prunable,
        stale,
        // A task whose dispatch failed is that decision, not whatever its
        // leftover workspace or label would name it — so it is filtered out
        // of the ordinary kinds rather than shown twice. The failures that
        // have no row here yet are read back in `interpret`.
        decisions: decisionsOf(claimedActive, reviewingActive, owned).filter(
          (decision) => !failedIds.has(decision.task.id),
        ),
        pinned,
      };
    };

    /** What fill decides from: one reading, narrowed to what a dispatch turns on. */
    const readDispatch = (providers: ReadonlyArray<Provider>) =>
      Effect.gen(function* () {
        const failed = failedTasks(yield* Ref.get(dispatchFailures));
        return dispatchFrom(yield* observe, providers, failed);
      });

    /**
     * Everything one observation implies, including what only a person reads.
     *
     * `dispatchFrom` plus the columns a dashboard draws and nothing decides
     * from — which cost a `prog show` per branch and a `git status` per
     * worktree, and are why the tick's second reading calls `dispatchFrom`
     * directly instead of coming back through here.
     */
    const interpret = (observation: Observation, providers: ReadonlyArray<Provider>) =>
      Effect.gen(function* () {
        const failed = failedTasks(yield* Ref.get(dispatchFailures));
        const current = dispatchFrom(observation, providers, failed);
        const { claimed, reviewing, queue, branches } = observation;
        const { committed } = current;
        const ownedByTask = new Set(current.owned.map((entry) => entry.task.id));

        // Everything below is read for a person to look at rather than for a
        // dispatch to turn on, which is why it is here and not in `dispatchFrom`:
        // the tick's second reading skips all of it.
        const landed = yield* eachProject((project) => prog.landed(project.name));

        const now = yield* DateTime.now;

        const workCandidates = new Map(
          [...queue, ...claimed, ...reviewing]
            .filter(
              (task) =>
                authoredBy(task) !== undefined &&
                !committed.has(task.id) &&
                !ownedByTask.has(task.id),
            )
            .map((task) => [task.id, task]),
        );
        const unfinished = yield* Effect.forEach(workCandidates.values(), (task) =>
          repository.holdsWork(directoryFor(task.project, task.id)).pipe(
            Effect.map((holdsWork) => (holdsWork ? [task.id] : [])),
            Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
          ),
        ).pipe(Effect.map((ids) => ids.flat()));
        const resumable = new Set([...committed, ...unfinished]);

        // Every branch, joined to whatever prog still says about its task. Read
        // for all of them rather than for a pre-filtered few, so the one rule
        // that decides which are unread sees the same rows the operator does.
        // A branch whose task was deleted outright resolves to nothing at all,
        // and it is the reason to read git rather than prog, so it is kept.
        //
        // Oldest first, which is the order they are recovered in.
        const unreviewed = yield* Effect.forEach(branches, ({ branch, task, project, merged }) =>
          prog.show(task).pipe(
            Effect.map((item) => ({
              title: item.title as string | undefined,
              status: item.status as string | undefined,
              activity: item.last_activity_at as Date | undefined,
            })),
            Effect.orElseSucceed(() => ({
              title: undefined,
              status: undefined,
              activity: undefined,
            })),
            Effect.map((item) => ({ project, branch, task, merged, ...item })),
          ),
        ).pipe(
          Effect.map((rows) =>
            rows
              .filter(isUnread)
              // `merged` is what the rule was decided from, and every surviving
              // row has the same answer, so it is not carried into the column.
              .map(({ project, branch, task, title, status, activity }): Unreviewed => ({
                project,
                branch,
                task,
                title,
                status,
                activity,
              }))
              .sort((first, second) => waiting(first) - waiting(second)),
          ),
        );

        // A task whose dispatch failed twice with the same error is a decision,
        // not a queue entry to keep offering. The failure rides the row so the
        // operator sees what to clear before retrying. The tally lives across
        // ticks, so the decision outlasts the tick that recorded the failure.
        const failedDecisions = yield* Effect.forEach(failed, ([task, failure]) =>
          prog.show(task).pipe(
            Effect.map((item): Active => ({
              task: item,
              worker: undefined,
              kind: undefined,
              failure: failure.detail,
            })),
            // The task may have been closed or deleted since it failed.
            Effect.orElseSucceed(() => undefined),
          ),
        ).pipe(Effect.map((rows) => rows.filter((row): row is Active => row !== undefined)));

        return {
          ...current,
          resumable,
          unreviewed,
          // Newest landing first: the column is history, and prog returns it
          // grouped by project in config order rather than by when work landed.
          landed: landedColumn(landed, now, settings.landedWindow),
          decisions: [...current.decisions, ...failedDecisions],
          dispatch: yield* Ref.get(dispatch),
          observedAt: now,
        } satisfies Interpretation;
      });

    /**
     * The trials row for a run that has just ended, written where the ending is
     * decided rather than once at the end of the tick.
     *
     * Two endings sit outside the settle loop's own pass — a handoff with
     * nothing committed, and a task whose workspace is residue — so a row
     * written only from the phase pass would silently omit them. The rung is
     * read off the task rather than passed in, because the model that ran is
     * what the row is about and `by:*` is the only record of it.
     *
     * Nothing happens for a phase that has not ended, or a run whose rung the
     * config no longer names: a row with no model would be a fact about
     * nothing.
     */
    const recordTrial = (task: Item, phase: TaskPhase): Effect.Effect<void> => {
      const ran = reviewedBy(task) ?? authoredBy(task);
      const rung = settings.ladder.find((candidate) => candidate.name === ran);
      const row =
        rung === undefined
          ? undefined
          : trialFor({
              task,
              branch: labelFor(task.id),
              harness: rung.harness,
              model: rung.model,
              provider: providerOf(rung),
              role: reviewedBy(task) ? "review" : "author",
              phase,
            });
      return row === undefined ? Effect.void : trials.record(row);
    };

    /**
     * Resolves every worker that stopped, by re-reading its task rather than
     * by interpreting anything the agent printed.
     *
     * An author handing off to review is a success, not a completion: the task
     * stays alive and the review queue picks it up next tick.
     */
    const settle = Effect.fn("foreman.settle")(function* (current: Interpretation) {
      const coachCutoff = DateTime.subtract(yield* DateTime.now, {
        minutes: settings.coachWindow,
      });

      yield* Effect.forEach(
        current.review.filter(({ task, worker }) => readyToLand(task, worker)),
        ({ task, worker }) => land(task, worker),
        { discard: true },
      );

      // An author that handed back an empty branch did not finish, whatever
      // it said by moving the task. Sending a reviewer costs a second agent
      // to read an empty diff. So the task goes back to the queue, which is
      // where unfinished work belongs.
      yield* Effect.forEach(
        current.unbacked,
        ({ task, kind }) =>
          Effect.gen(function* () {
            yield* unfinished(
              task,
              `foreman: ${kind ?? "the author"} handed ${task.id} back for review with nothing committed on ${labelFor(task.id)} — there is no work to review.`,
            );
            // Unfinished for the same reason `unfinished` says it is: the run
            // ended having produced nothing a reviewer could read.
            yield* recordTrial(task, "Unfinished");
            yield* teardown(task);
          }),
        { discard: true },
      );

      yield* Effect.forEach(
        current.owned.filter(
          ({ task, worker }) =>
            diagnosticIntent(task) !== undefined &&
            worker.state !== "working" &&
            worker.state !== "blocked",
        ),
        ({ task, worker }) =>
          Effect.gen(function* () {
            yield* prog.release(task.id);
            yield* fleet.stop(worker, "author");
            yield* prog.clearDiagnostic(task.id);
            yield* dispatchAuthor(task);
            yield* Effect.logInfo(`resumed ${task.id} after diagnostic intervention`);
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning(`resuming ${task.id} after diagnosis failed: ${error}`),
            ),
          ),
        { discard: true },
      );

      yield* Effect.forEach(
        current.owned.filter(
          ({ task, worker }) =>
            diagnosticIntent(task) === undefined &&
            !awaitingLanding(task) &&
            worker.state !== "working",
        ),
        ({ task, worker, kind }) =>
          Effect.gen(function* () {
            const reviewer = reviewedBy(task);
            const holdsWork =
              worker.state === "gone" && worker.worktree !== undefined
                ? yield* repository.holdsWork(worker.worktree)
                : false;
            const phase = phaseOf({
              status: task.status,
              reviewer,
              worker: worker.state,
              worktree: worker.worktree !== undefined,
              committed: current.committed.has(task.id),
              holdsWork,
              handoffExpired: handoffExpired(task, coachCutoff),
            });

            // The rung that actually ran, which is what an outcome is about —
            // the reviewer where one owns the pane, else the author.
            const ran = reviewedBy(task) ?? authoredBy(task);
            const rung = settings.ladder.find((candidate) => candidate.name === ran);
            const role = reviewedBy(task) ? "review" : "author";
            if (rung) {
              const attributes = runAttributes(task, rung, role);
              yield* Effect.annotateCurrentSpan({ ...attributes, outcome: phase });
              yield* Metric.update(
                Metric.withAttributes(runOutcomes, {
                  rung: rung.name,
                  project: task.project,
                  outcome: phase,
                }),
                1,
              );

              // The same fact the run telemetry carries, appended to the trials
              // table the coordinator reads by hand at every slice close. Both
              // are written here, once, so they cannot describe different runs.
              yield* recordTrial(task, phase);
            }

            yield* Match.value(phase).pipe(
              Match.when("Landed", () =>
                fleet
                  .notify("Task landed", `${task.id} ${task.title}`)
                  .pipe(Effect.andThen(teardown(task))),
              ),
              Match.when("Canceled", () =>
                fleet
                  .notify("Task canceled", `${task.id} ${task.title}`)
                  .pipe(Effect.andThen(teardown(task))),
              ),
              Match.when("ReviewReturned", () =>
                prog
                  .clearReview(task.id)
                  .pipe(
                    Effect.andThen(
                      prog.log(
                        task.id,
                        `foreman: reviewer ${reviewer} sent ${task.id} back with findings. Returned to the queue one rung up — read the review notes above and continue from ${labelFor(task.id)}.`,
                      ),
                    ),
                    Effect.andThen(climb(task)),
                    Effect.andThen(stopAgents(worker)),
                    Effect.andThen(
                      fleet.notify(
                        "Review returned",
                        `${task.id} was sent back by ${reviewer} — one rung up for its next author`,
                      ),
                    ),
                  ),
              ),
              Match.when("VanishedAttached", () => Effect.void),
              Match.when("VanishedWithWork", () =>
                unfinished(
                  task,
                  `foreman: ${kind ?? "the author"} vanished mid-task and left unfinished work in ${worker.worktree}. Read git status and git log ${labelFor(task.id)} before you plan anything, and continue from what is there.`,
                ),
              ),
              Match.when("VanishedEmpty", () =>
                unfinished(
                  task,
                  `foreman: ${kind ?? "the author"} vanished without writing anything — no commits on ${labelFor(task.id)} and an untouched worktree.`,
                ).pipe(Effect.andThen(teardown(task))),
              ),
              Match.when("Blocked", () => Effect.void),
              Match.when("ReviewWaiting", () => Effect.void),
              Match.when("ReviewExpired", () => stopAgents(worker)),
              Match.when("ReviewStopped", () =>
                unfinished(task, `foreman: reviewer ${reviewer} stopped without a verdict.`).pipe(
                  Effect.andThen(stopAgents(worker)),
                  Effect.andThen(
                    fleet.notify(
                      "Review returned",
                      `${task.id} reviewer stopped without a verdict — back in the queue`,
                    ),
                  ),
                ),
              ),
              Match.when("Residue", () =>
                Effect.forEach([...worker.roles.keys()], (role) => fleet.stop(worker, role), {
                  discard: true,
                }),
              ),
              Match.when("Unfinished", () =>
                unfinished(
                  task,
                  `foreman: ${kind ?? "agent"} stopped without finishing (status ${task.status}).`,
                ).pipe(
                  Effect.andThen(teardown(task)),
                  Effect.andThen(
                    fleet.notify(
                      "Task returned",
                      `${task.id} stopped unfinished — back in the queue`,
                    ),
                  ),
                ),
              ),
              Match.exhaustive,
            );
          }).pipe(
            Effect.withSpan("foreman.settle.run"),
            Effect.catch((error) => Effect.logWarning(`settling ${task.id} failed: ${error}`)),
          ),
        { discard: true },
      );
    });

    /**
     * Puts a finished branch into the operator's checkout.
     *
     * The only code path that writes there. No agent holds merge rights, reviewer
     * or author, so every branch passes the same clean-checkout and verification
     * gate.
     */
    const land = Effect.fn("foreman.land")(function* (task: Item, worker: Worker | undefined) {
      yield* Effect.gen(function* () {
        const project = projectFor(task.project);
        if (!project) return;

        const result = yield* repository.merge(
          project.directory,
          labelFor(task.id),
          project.verify,
          verifyDirectoryFor(project.name),
        );
        // The verdict is a durable label, so a later tick lands from it with no
        // pane at all — and a project can stay dirty for hours.
        if (result._tag === "Held") {
          // An operator editing clears itself and is not worth a line every
          // poll. Any other hold — a missing landing target, a machine foreman
          // could not run — never clears and must not retry in silence.
          if (result.reason !== "dirty" && result.detail) {
            yield* Effect.logWarning(`landing ${task.id} (${project.name}) held: ${result.detail}`);
          }
          return yield* stopAgents(worker);
        }

        // A conflict is not evidence about the model, so it does not climb.
        // Every author branches from the trunk's tip, so a branch whose tip
        // has not moved fast-forwards and cannot conflict at all: a conflict
        // therefore means the trunk moved after this branch was cut, which no
        // model is stronger or weaker at avoiding. Spending a better one on
        // the retry buys nothing, and it is the resolution — not the work —
        // that is outstanding. A task that genuinely cannot get past it still
        // ends unfinished, and `unfinished` is what bounds that.
        if (result._tag === "Rejected") {
          yield* Effect.logWarning(
            `landing ${task.id} (${project.name}) rejected: ${result.detail}`,
          );
          yield* prog.log(
            task.id,
            `foreman: this branch no longer merges into ${project.name}'s checkout, because the trunk moved after the branch was cut:\n\n${result.detail}\n\nReturned to the queue at the same rung. Merge the current trunk into this branch and resolve those paths before anything else — the work already on the branch may have been overtaken, so read what the trunk did to those files before assuming the branch's version is the one to keep.`,
          );
          yield* prog.release(task.id);
          return yield* fleet.notify(
            "Landing failed",
            `${task.id} is behind ${project.name} — back in the queue to rebase`,
          );
        }

        // The branch broke the project. Nothing reached the checkout, so what
        // the task needs is the output — the next author's whole job is the
        // failure below.
        if (result._tag === "Broke") {
          yield* Effect.annotateCurrentSpan("verification", "broken");
          yield* Effect.logWarning(`landing ${task.id} broke ${project.name}'s verification`);
          yield* prog.log(
            task.id,
            `foreman: merging this branch fails ${project.name}'s verification, so it was not landed and the task is back in the queue.\n\n${result.output}`,
          );
          yield* climb(task);
          yield* prog.release(task.id);
          return yield* fleet.notify(
            "Landing reverted",
            `${task.id} broke ${project.name} — back in the queue`,
          );
        }

        // Both remaining verdicts end the task, and differ only in what foreman
        // may honestly say it did. `Present` wrote nothing and ran nothing, so
        // it claims neither a merge nor a verification. Two things reach it:
        // an interrupted landing whose merge had already gone in, and a branch
        // whose author found the trunk already satisfied the task and whose
        // reviewer confirmed it. The verdict cannot tell them apart — an empty
        // branch is contained by any checkout — so the label the author left
        // is what names the one in the log.
        if (result._tag === "Present") {
          yield* Effect.logInfo(
            `${task.id} (${project.name}) was already in the checkout; completing`,
          );
          yield* prog.log(
            task.id,
            isSatisfied(task)
              ? `foreman: ${project.name}'s trunk already does what this task asked, and the reviewer confirmed it. Nothing was merged and nothing was verified — the backlog had outlived the work.`
              : isResearch(task)
                ? `foreman: this task's deliverable was a report, and the reviewer confirmed it against its evidence in the log. Nothing was merged and nothing was verified — there was no code to land.`
                : `foreman: ${project.name}'s checkout already contained this branch, so there was nothing to merge. An earlier landing put the commits in without reaching this step.`,
          );
        } else {
          if (!result.verified) {
            yield* prog.log(
              task.id,
              `foreman: landed on git's exit code alone — ${project.name} names no verification command, or its checkout was already failing before the merge.`,
            );
          }

          // The one line in this file that records a write to a directory a
          // person also works in. Everything else foreman does happens in a
          // worktree it owns and can throw away.
          yield* Effect.logInfo(
            `landed ${task.id} (${project.name})${result.verified ? "" : ", unverified"}`,
          );
        }

        yield* prog.complete(task.id);
        yield* fleet.notify("Task landed", `${task.id} ${task.title}`);
        yield* teardown(task);
      }).pipe(Effect.catch((error) => Effect.logWarning(`landing ${task.id} failed: ${error}`)));
    });

    /**
     * Deletes the branches whose work the projects already have and no task
     * still refers to.
     *
     * A sweep rather than a step inside landing, because a merge is not the
     * only way a branch arrives in the checkout — you land one by hand and the
     * ref should go the same way. It runs every tick against the world as it
     * is, so nothing has to remember what it merged.
     *
     * What it may not sweep is a branch some task is still in the middle of,
     * because that ref is the only proof the task's author committed anything.
     * Delete it while the task is still in review and the next tick reads a
     * task with no branch, concludes nothing was written, and sends finished
     * work back to the queue.
     */
    const tidy = (current: Interpretation) =>
      Effect.gen(function* () {
        // A landing killed mid-merge leaves an unpublished merge commit in a
        // colocated checkout, and a restart is what kills it — landing into
        // its own checkout under `bun --watch` restarts the daemon on every
        // write. The branch still holds the work, so the retry re-lands it
        // honestly and the leftover head is swept here, beside the branch
        // sweep, where every tick's cleanup lives.
        yield* Effect.forEach(
          settings.projects,
          (project) =>
            repository.sweepUnpublishedMerges(project.directory).pipe(
              Effect.flatMap((litter) =>
                Effect.forEach(
                  litter,
                  (id) => Effect.logInfo(`abandoned ${id.slice(0, 8)} in ${project.name}`),
                  { discard: true },
                ),
              ),
              Effect.catch((error) =>
                Effect.logWarning(`sweeping landing litter in ${project.name} failed: ${error}`),
              ),
            ),
          { discard: true },
        );

        yield* Effect.forEach(
          current.prunable,
          (entry) =>
            repository.remove(entry.directory, entry.branch).pipe(
              Effect.flatMap((deleted) =>
                deleted
                  ? // Named rather than counted. A branch foreman deleted is the
                    // one thing about a prune anyone ever goes looking for
                    // afterwards, and there are only ever a handful in a tick.
                    Effect.logInfo(`pruned ${entry.branch} in ${entry.project}`)
                  : Effect.void,
              ),
              Effect.catch((error) =>
                Effect.logWarning(`pruning ${entry.branch} in ${entry.project} failed: ${error}`),
              ),
            ),
          { discard: true },
        );
      });

    /**
     * Returns claims that nobody is working on any more.
     *
     * Ownership decides this, not age: a task with a live workspace is being
     * worked on by definition. Age only guards the claims foreman does not
     * own, so a claim made by hand in another pane is not stolen from someone
     * who is still typing — and a claim awaiting an operator's decision is
     * left alone until it goes properly stale.
     */
    const reclaim = (current: Interpretation) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const cutoff = DateTime.subtract(now, { hours: settings.staleAfter });

        yield* Effect.forEach(
          [
            ...current.working,
            ...current.review.filter(({ task }) => reviewedBy(task) !== undefined),
          ].filter(
            ({ task, worker }) =>
              (worker === undefined || worker.state === "gone") &&
              DateTime.isLessThan(DateTime.fromDateUnsafe(task.last_activity_at), cutoff),
          ),
          ({ task, worker }) =>
            Effect.gen(function* () {
              yield* prog.log(
                task.id,
                `foreman: claim released — no activity since ${task.last_activity_at.toISOString()}.`,
              );
              yield* prog.release(task.id);
              // Only a workspace that still exists is taken down. A worker
              // whose workspace already closed leaves its worktree behind on
              // purpose: it may hold the interrupted agent's edits, and the
              // next author opens onto them.
              if (worker) yield* teardown(task);
              yield* Effect.logInfo(`reclaimed ${task.id} (${task.project})`);
            }).pipe(
              Effect.catch((error) => Effect.logWarning(`reclaiming ${task.id} failed: ${error}`)),
            ),
          { discard: true },
        );
      });

    /**
     * Puts the longest-waiting recoverable branch back in front of a reviewer.
     *
     * Everything else foreman does about a branch is reached through its task,
     * and these are the branches whose task no longer reaches anything. Nothing
     * will pick them up, so nothing will pick them up next tick either: without
     * this they wait on an operator noticing a row, which is the manual step
     * this exists to delete.
     *
     * One per tick, oldest first, so the list works itself off in the order the
     * work was abandoned and never arrives as a burst of reviewers. It needs no
     * counter to do that: submitting the oldest is what makes the next tick see
     * a different oldest, and a tick that finds none does nothing.
     *
     * `submit`, not a dispatch. The review pass already orders reviews ahead of
     * new work and picks the rung off the ladder, and recovered work has no
     * claim to jump that. It runs while draining for the same reason the review
     * pass does: this is the pipeline emptying itself, not taking work on.
     */
    const recover = (current: Interpretation) =>
      Effect.gen(function* () {
        const oldest = current.unreviewed.find(recoverable);
        if (!oldest) return;
        yield* prog.submit(oldest.task);
        yield* prog.log(
          oldest.task,
          `foreman: ${oldest.task} is done, but ${oldest.branch} still holds commits ${oldest.project} never took, so the landing never completed. Nothing in the pipeline reaches a done task, so it is back in review to decide whether the work is worth landing.`,
        );
        yield* Effect.logInfo(`recovered ${oldest.task} (${oldest.project}) for review`);
      }).pipe(Effect.catch((error) => Effect.logWarning(`recovering a branch failed: ${error}`)));

    /**
     * Claims work for every free slot, review first.
     *
     * Tasks in a held project are passed over. Every branch eventually merges
     * into that checkout, so dispatching there would put its landing against
     * the operator's own edits — and the operator would find their branch
     * moving under them mid-change. The tasks stay in the queue, and the
     * dashboard names the project so the reason is visible rather than
     * mysterious.
     */
    const fill = (current: Dispatchable, mode: Dispatch) =>
      Effect.gen(function* () {
        // A task whose dispatch has failed twice is held out of both passes.
        // Its failure is a fact about the world, so a third attempt would
        // repeat the second; the operator clears the cause and retries.
        const failed = new Set(failedTasks(yield* Ref.get(dispatchFailures)).map(([task]) => task));

        const stale = new Set(current.stale.map((row) => row.task.id));
        // This tick's burst, not a memory: one set per fill pass, read by the
        // author pass only, and discarded with it. Its whole job is to stop every
        // slot in this pass drawing on the one account the reading calls healthy.
        const drawn = new Set<string>();
        yield* Effect.forEach(
          dispatchesFor(current, settings.slots, mode === "running", failed, stale),
          (dispatch) =>
            dispatch.role === "review"
              ? dispatchReview(dispatch.task, authoredBy(dispatch.task)).pipe(
                  Effect.tap(() => clearFailure(dispatch.task.id)),
                  Effect.catch((error) => recordFailure(dispatch.task.id, error)),
                )
              : dispatchAuthor(dispatch.task, drawn).pipe(
                  Effect.tap(() => clearFailure(dispatch.task.id)),
                  Effect.catch((error) => recordFailure(dispatch.task.id, error)),
                ),
          { discard: true },
        );
      });

    /**
     * The workspace a task's agents run in, with its worktree made usable.
     *
     * Every dispatch goes through here so the setup step cannot drift between
     * the paths that need it. A worktree whose setup failed is not handed to an
     * agent: the failure is the project's or the machine's, never the task's,
     * and an agent given a directory that cannot build will spend its run
     * discovering that and charge it to the branch.
     */
    const workspaceFor = (task: { id: string; project: string }, project: Project) =>
      Effect.gen(function* () {
        const worker = yield* fleet.open({
          task: task.id,
          repository: project.directory,
          branch: labelFor(task.id),
          directory: directoryFor(task.project, task.id),
        });
        const setup = yield* repository.setup(worker.directory);
        if (setup && !setup.passed) {
          return yield* new RepositoryError({
            directory: worker.directory,
            detail: `worktree setup failed:\n${setup.output}`,
          });
        }
        return worker;
      });

    /**
     * The rung that authors a task now, or nothing when none can.
     *
     * The author's mirror of the reviewer resolution below, and it reads the
     * same tick's allowances for the same reason: every dispatch and the gate
     * that offered the task must agree, or the gate passes over work a dispatch
     * would have found an agent for. `undefined` is not an error — the queue
     * keeps the task and a later tick, or an allowance reset, asks again.
     */
    const rungNow = Effect.fnUntraced(function* (
      task: {
        readonly id: string;
        readonly labels: ReadonlyArray<string>;
      },
      drawn?: Set<string>,
    ) {
      const walled = walledRungs((yield* SubscriptionRef.get(state)).providers);
      const choice = authorFor(settings.ladder, failuresOf(task), walled, drawn ?? new Set());
      if (choice._tag === "Dispatch") {
        const provider = providerOf(choice.rung);
        if (provider !== undefined) drawn?.add(provider);
        return choice.rung;
      }
      yield* Effect.logInfo(
        choice._tag === "Waiting"
          ? `${task.id} deferred: no account with room on ${choice.walled.join(", ")}`
          : `${task.id} deferred: every rung of the ladder has already failed it`,
      );
      return undefined;
    });

    const dispatchAuthor = Effect.fn("foreman.dispatch.author")(function* (
      task: ReadyTask,
      drawn?: Set<string>,
    ) {
      // The bottom rung by default; higher only where the rungs below have
      // already been tried and failed, or cannot be paid for. The task carries
      // the failures in its labels, so the choice survives a restart, and the
      // allowances are this tick's reading. `drawn` is this tick's burst, not the
      // task's history: only `fill` has one, so only it spreads.
      const rung = yield* rungNow(task, drawn);
      if (rung) yield* authorAt(task, rung);
    });

    /** Opens the task's workspace, claims it and starts its author on this rung. */
    const authorAt = Effect.fn("foreman.dispatch.authorAt")(function* (
      task: ReadyTask,
      rung: Rung,
    ) {
      const project = projectFor(task.project);
      if (!project) return;

      // The workspace opens before the claim. If it opened after, a task
      // would briefly be claimed with nothing to show for it, and that state
      // is indistinguishable from an abandoned claim.
      const worker = yield* workspaceFor(task, project);

      const prompt = yield* prompts.author(
        task,
        worker.directory,
        project.directory,
        project.verificationSkill,
      );
      yield* prog.claim(task.id);
      yield* prog.attribute(task.id, rung.name).pipe(Effect.tapError(() => prog.release(task.id)));
      const agent = yield* instrumentRun(
        task,
        rung,
        "author",
        fleet.spawn(worker, spawnAs(rung, prompt, "author")).pipe(
          // The agent never started, so the claim would strand the task until
          // the stale sweep noticed. Hand it back immediately instead.
          Effect.tapError(() => prog.release(task.id)),
        ),
      );
      yield* prog.log(task.id, agentLog("author", rung, agent));
      yield* Effect.logInfo(
        `dispatched ${task.id} (${task.project}) to ${rung.name} in ${worker.directory}`,
      );
    });

    const dispatchReview = Effect.fn("foreman.dispatch.review")(function* (
      task: Item,
      author: string | undefined,
    ) {
      const project = projectFor(task.project);
      if (!project) return;

      // The fork point is how the reviewer names the author's work from
      // inside its own worktree; without it the only diff it could read is in
      // the operator's checkout. The status is untouched, so a later tick
      // tries again.
      const base = yield* repository.base(project.directory, labelFor(task.id));
      if (!base) {
        return yield* Effect.logWarning(
          `review of ${task.id} deferred: no merge base for ${labelFor(task.id)} in ${project.directory}`,
        );
      }

      // Resolved here rather than by each caller, so fill, the settle handoff,
      // a retry and an intervention all pick a reviewer the same way. The
      // reading is the tick's own: `state` is published before any pass runs,
      // and for an operator-triggered dispatch it is the same reading the quota
      // view was showing when they pressed the key.
      const rung = reviewerFor(
        settings.ladder,
        author,
        walledRungs((yield* SubscriptionRef.get(state)).providers),
      );
      if (!rung) {
        // Every rung that could read this diff is spent. The status is
        // untouched, so the task keeps its place and a later tick — or an
        // allowance reset — tries again.
        return yield* Effect.logInfo(
          `review of ${task.id} deferred: no account with room at or above ${author ?? "the top rung"}`,
        );
      }
      const worker = yield* workspaceFor(task, project);

      const prompt = yield* prompts.review(
        task,
        worker.directory,
        project.directory,
        base,
        project.verify,
        project.verificationSkill,
      );
      yield* prog.assignReview(task.id, rung.name);
      const agent = yield* instrumentRun(
        task,
        rung,
        "review",
        fleet
          .spawn(worker, spawnAs(rung, prompt, "review"))
          .pipe(Effect.tapError(() => prog.clearReview(task.id))),
      );
      yield* prog.log(task.id, agentLog("review", rung, agent));
      yield* Effect.logInfo(`review of ${task.id} (${task.project}) to ${rung.name}`);
    });

    /**
     * Sends an agent into a project's own checkout to salvage what is there.
     *
     * Onboarding is how a held project rejoins the queue without the operator
     * doing the reconciling by hand. The agent reads the uncommitted work,
     * names what it was doing, runs the project's own checks, commits what it
     * finds to a rescue branch, and puts the operator's branch back where it
     * was with a clean tree. Whatever it found broken becomes ordinary tasks in
     * that project, which the fleet then picks up with review like any others.
     *
     * The frontier model, always. Reading a hundred files of abandoned work and
     * inferring what somebody meant is the judgement cheap models are worst at,
     * and this runs once per project rather than once per task.
     */
    const onboard = (project: Project) =>
      Effect.gen(function* () {
        const id = yield* prog.add(
          project.name,
          `Adopt uncommitted work in ${project.name}`,
          `Foreman found uncommitted changes in ${project.directory} and held the project. This task is the salvage run: preserve the work on a rescue branch, report what it was doing and what passes, and leave the checkout clean.`,
          [ONBOARD],
        );

        yield* dispatchOnboard(yield* prog.show(id), project);
      });

    const dispatchOnboard = Effect.fn("foreman.dispatch.onboard")(function* (
      task: Item,
      project: Project,
    ) {
      const rung = topOf(settings.ladder);

      // Attached, not a worktree: the work being rescued exists only in this
      // checkout, so a copy of the last commit would show the agent nothing.
      const worker = yield* fleet.attach({ task: task.id, repository: project.directory });
      const prompt = yield* prompts.onboard(task, project.directory);

      yield* prog.claim(task.id);
      yield* prog.attribute(task.id, rung.name).pipe(Effect.tapError(() => prog.release(task.id)));
      const agent = yield* instrumentRun(
        task,
        rung,
        "author",
        fleet
          .spawn(worker, spawnAs(rung, prompt, "author"))
          .pipe(Effect.tapError(() => prog.release(task.id))),
      );
      yield* prog.log(task.id, agentLog("author", rung, agent));
      yield* Effect.logInfo(`onboarding ${project.name} as ${task.id} with ${rung.name}`);
    });

    /**
     * Routes an agent that stopped without finishing, which has said nothing
     * about its rung.
     *
     * A crash, a timeout and a usage wall all end identically, so the task
     * stays on the rung and is tried again, up to `attemptsPerRung`; the
     * attempt that reaches the limit is the one that climbs, and the climb
     * clears the count for the next rung. Every ending writes its count to the
     * task, so a dispatch days later reads how many tries this rung has
     * already had. A reviewer rejecting the work is a judgement and never
     * passes through here.
     *
     * The task is released before the count is written. A release that fails
     * leaves the task claimed, so a count written ahead of it would be read
     * again on the next tick and climb the task a rung early; a count left
     * unwritten by the opposite order merely gives the rung one more try.
     */
    const unfinished = (task: Climbing, detail: string) =>
      Effect.gen(function* () {
        yield* prog.release(task.id);
        const rung = ranAt(task);
        const attempts = attemptsOf(task, rung) + 1;
        if (rungSpent(attempts, settings.attemptsPerRung)) {
          yield* prog.log(
            task.id,
            `${detail} Returned to the queue one rung up — ${attempts} attempts on ${rung} exhausted it.`,
          );
          yield* climb(task);
        } else {
          yield* prog.log(
            task.id,
            `${detail} Returned to the queue to try ${rung} again (attempt ${attempts} of ${settings.attemptsPerRung}).`,
          );
          yield* prog.markAttempt(task.id, rung, attempts);
        }
      });

    /**
     * The rung whose run has just ended, which is the one a verdict is about.
     *
     * Read from the task rather than recomputed: `by:*` says which model
     * actually ran, while the ladder would answer with whichever rung is
     * available now — and the two differ exactly when an account went spent
     * mid-run, which is when charging the wrong model would be worst. A task
     * with no author recorded has never been dispatched, so the rung it would
     * get next is the honest answer.
     */
    const ranAt = (task: Climbing): string =>
      authoredBy(task) ?? nextRung(task)?.name ?? settings.ladder[0].name;

    const nextRung = (task: { readonly labels: ReadonlyArray<string> }): Rung | undefined => {
      const choice = authorFor(settings.ladder, failuresOf(task));
      return choice._tag === "Dispatch" ? choice.rung : undefined;
    };

    /**
     * Records that the rung which just ran was not enough, and says so when
     * nothing is left above it.
     *
     * The paths that hand work back to the queue with a judgement about it come
     * through here — a reviewer sending work back, a branch that broke the
     * project's verification — so the evidence that a rung failed is written
     * where the next dispatch reads it rather than being lost with the worker.
     * A branch that merely would not merge is not one of them: that is the
     * trunk having moved, which says nothing about the model. An agent that
     * merely stopped unfinished does not fail its rung until the rung is spent.
     *
     * What is written is the failure, never the model that comes next: which
     * rung takes it depends on what is configured and paid for at the moment of
     * dispatch, and a task that named its next model would be stranded by a
     * config edit or a spent account. With every configured rung failed the
     * task is the operator's: one the best model could not finish should stop,
     * not cycle. Silence there would mean waiting forever, so it is announced
     * like any other worker that needs somebody. A rung that is merely walled
     * is not exhaustion — the account resets and the fleet carries on — so the
     * account is left out of this reading.
     */
    const climb = (task: Climbing) =>
      Effect.gen(function* () {
        const failed = ranAt(task);
        yield* prog.markFailure(task.id, failed);
        const next = authorFor(settings.ladder, [...failuresOf(task), failed]);
        // The durable write, not an unfinished attempt: this annotation records
        // exactly the evidence the ladder acted on.
        yield* Effect.annotateCurrentSpan({
          escalation: "true",
          "rung.failed": failed,
          "rung.next": next._tag === "Dispatch" ? next.rung.name : next._tag,
        });
        if (next._tag === "Yours") {
          yield* prog.log(
            task.id,
            `foreman: every rung of the ladder has been tried on ${task.id}. It is yours now — write the decision into this task, then remove the failures it recorded to put it back in the queue.`,
          );
          yield* fleet.notify("Needs a decision", `${task.id} ${task.title}`);
        }
      });

    /**
     * Takes back the highest failure recorded against a task, at the operator's
     * word.
     *
     * The mirror of `climb`, and the correction for every way a rung gets
     * failed without deserving it — a bug, an OOM, an operator killing a run.
     * One step per press, unwriting exactly the label foreman itself would have
     * written, so the work drops back to the model below. With nothing recorded
     * there is nothing to take back: the task is already at the bottom of the
     * ladder.
     */
    const descend = (task: Climbing) =>
      Effect.gen(function* () {
        // A parked task stands above the top rung, so the step down from it is
        // out of the operator's column and onto the strongest model — which is
        // where the failures it already carries put it. Removing the park is
        // that step; the failures are the next one.
        if (needsYou(task)) return yield* prog.clearNeedsYou(task.id);
        const highest = highestFailure(settings.ladder, failuresOf(task));
        if (highest === undefined) return;
        yield* prog.clearFailure(task.id, highest);
      });

    const projectFor = (name: string) =>
      settings.projects.find((candidate) => candidate.name === name);

    const branchCommitted = (task: Item) => {
      const project = projectFor(task.project);
      if (!project) return Effect.succeed(false);
      return repository
        .branches(project.directory)
        .pipe(
          Effect.map(
            (branches) =>
              branches.find((branch) => branch.branch === labelFor(task.id))?.empty === false,
          ),
        );
    };

    const holdsIntervenableWork = (task: Item, worker: Worker | undefined) =>
      worker
        ? Effect.succeed(true)
        : branchCommitted(task).pipe(
            Effect.flatMap((committed) =>
              committed
                ? Effect.succeed(true)
                : repository
                    .holdsWork(directoryFor(task.project, task.id))
                    .pipe(Effect.orElseSucceed(() => false)),
            ),
          );

    /**
     * Ends every agent on a task's workspace.
     *
     * Nothing ends a settled agent but closing it, so it
     * holds its model's memory for as long as the pane exists, and a pane
     * already carrying a role is never dispatched into again. Every settle
     * whose record is already in the task store therefore ends here: what the
     * agent did is in the log, and the pane is only cost from there on. The
     * worktree outlives the workspace, so the next role re-adopts it through
     * `Fleet.open` with the uncommitted work still in it.
     *
     * All roles, not the one the labels call active. An author outlives its
     * handoff now, so author and reviewer are legitimately live at once and
     * naming a single role from the task store would guess wrong exactly when
     * both exist. Every caller here means "end this task's agents" anyway.
     */
    const stopAgents = (worker: Worker | undefined) =>
      worker
        ? Effect.forEach([...worker.roles.keys()], (role) => fleet.stop(worker, role), {
            discard: true,
          })
        : Effect.void;

    const dispatchDiagnostic = (
      target: InterventionTarget,
      intent: DiagnosticIntent,
      rungName: string,
    ) =>
      Effect.gen(function* () {
        const task = yield* prog.show(target.task.id);
        if (task.status === "done" || task.status === "canceled") return;
        const project = projectFor(task.project);
        const rung = settings.ladder.find((candidate) => candidate.name === rungName);
        if (!project || !rung || !(yield* holdsIntervenableWork(task, target.worker))) return;

        yield* stopAgents(target.worker);
        if (reviewedBy(task) !== undefined) yield* prog.clearReview(task.id);
        if (task.status !== "open") yield* prog.release(task.id);
        yield* prog.markDiagnostic(task.id, intent);
        yield* Effect.gen(function* () {
          const worker = yield* workspaceFor(task, project);
          const prompt = yield* prompts.diagnose(task, worker.directory, project.directory, intent);
          yield* prog.claim(task.id);
          const agent = yield* instrumentRun(
            task,
            rung,
            "author",
            fleet.spawn(worker, spawnAs(rung, prompt, "author")),
          );
          yield* prog.log(
            task.id,
            `foreman: diagnostic ${intent} assigned to ${rung.name} (${agent.model ?? rung.model ?? rung.harness})`,
          );
          yield* Effect.logInfo(`${intent} intervention on ${task.id} with ${rung.name}`);
        }).pipe(
          Effect.onError(() =>
            prog
              .clearDiagnostic(task.id)
              .pipe(Effect.andThen(prog.release(task.id)), Effect.ignore),
          ),
        );
      });

    const dispatchFormalReview = (target: InterventionTarget) =>
      Effect.gen(function* () {
        const task = yield* prog.show(target.task.id);
        if (task.status === "done" || task.status === "canceled") return;
        yield* stopAgents(target.worker);
        if (reviewedBy(task) !== undefined) yield* prog.clearReview(task.id);
        if (task.status === "open") yield* prog.claim(task.id);
        if (task.status !== "reviewing") yield* prog.review(task.id);
        yield* dispatchReview(task, authoredBy(task));
      });

    /**
     * Records every rung below a chosen one as having failed, which is what the
     * operator saying "carry on from here" means.
     *
     * The only way to start a task at a rung, because a task never names the
     * rung that runs next — and it stays true if the choice cannot be paid for:
     * the floor holds and the dispatch steps up to an account with room,
     * exactly as it would have done for a failure foreman recorded itself.
     */
    const raiseFloor = (task: Item, rung: Rung) => {
      const already = new Set(failuresOf(task));
      const beneath = settings.ladder
        .slice(0, rankOf(settings.ladder, rung.name) ?? 0)
        .filter((lower) => !already.has(lower.name));
      return Effect.forEach(beneath, (lower) => prog.markFailure(task.id, lower.name), {
        discard: true,
      });
    };

    const dispatchContinuation = (target: InterventionTarget, rungName: string) =>
      Effect.gen(function* () {
        const task = yield* prog.show(target.task.id);
        if (task.status === "done" || task.status === "canceled") return;
        const rung = settings.ladder.find((candidate) => candidate.name === rungName);
        if (!rung) return;
        yield* stopAgents(target.worker);
        if (reviewedBy(task) !== undefined) yield* prog.clearReview(task.id);
        yield* prog.clearDiagnostic(task.id);
        if (task.status !== "open") yield* prog.release(task.id);
        yield* raiseFloor(task, rung);
        yield* dispatchAuthor(yield* prog.show(task.id));
      });

    /** The checkout a project's work lands in, when foreman is configured for it. */
    const repositoryFor = (task: { readonly project: string }) =>
      projectFor(task.project)?.directory;

    /**
     * Takes down a task's workspace and, with it, the worktree foreman made.
     * `fleet.close` resolves the same way `open` does, so a workspace the fleet has
     * already dropped still leaves its worktree removed rather than orphaned.
     */
    const teardown = (task: { readonly id: string; readonly project: string }) =>
      fleet.close({ task: task.id, repository: repositoryFor(task) });

    const eachProject = <A>(read: (project: Project) => Effect.Effect<ReadonlyArray<A>, Error>) =>
      Effect.forEach(settings.projects, (project) =>
        read(project).pipe(
          // One unreadable project must not blind foreman to the other seven.
          Effect.catch((error) =>
            Effect.logWarning(`skipped ${project.name}: ${error}`).pipe(
              Effect.as<ReadonlyArray<A>>([]),
            ),
          ),
        ),
      ).pipe(Effect.map((perProject) => perProject.flat()));

    return {
      /** What the dashboard renders. Replaced whole on every tick. */
      state,
      // Only rungs foreman can dispatch: a retired one keeps its rank so old
      // failures still position, but offering it would spawn nothing.
      rungs: dispatchableRungs(settings.ladder).map((rung) => rung.name),

      /** Reads and settles the world once. The daemon wraps this in `run`. */
      tick,

      /** Reads the world once without acting on it. */
      read: Effect.asVoid(read),

      /** Runs until interrupted. */
      run: Effect.gen(function* () {
        const mode = yield* Ref.get(dispatch);
        yield* Effect.logInfo(
          `foreman up: ${plural(settings.slots, "slot")} over ${plural(settings.projects.length, "project")}, polling every ${settings.pollInterval}s, starting ${mode}`,
        );
        return yield* tick.pipe(
          Effect.andThen(
            Effect.raceFirst(
              Effect.sleep(Duration.seconds(settings.pollInterval)),
              Queue.take(wake),
            ),
          ),
          Effect.forever,
        );
      }),

      /**
       * States how much work the fleet may take on. Live workers are never
       * interrupted by it; narrowing only stops the next dispatch.
       */
      setDispatch: (mode: Dispatch) =>
        commanded(
          Effect.gen(function* () {
            const was = yield* Ref.getAndSet(dispatch, mode);
            // The key cycles even against no change; only a real move is news.
            if (was !== mode) yield* Effect.logInfo(`dispatch: ${was} -> ${mode}`);
          }),
        ),

      /**
       * States whether the accounts are being read, so a paused fleet can stop
       * asking about them.
       *
       * Turning it on nudges the loop, so opening the view fills it on the
       * next tick rather than at the next poll. A dashboard that exits without
       * turning it off costs one probe per poll until the process ends, which
       * is the same process the screen was in.
       */
      watchQuota: (watching: boolean) => commanded(Ref.set(watchingQuota, watching)),

      /** Brings a task's workspace to the front so you can take over. */
      focus: (worker: Worker) => fleet.focus(worker),

      /** Stops a live attempt, records why, and returns the task unchanged to the queue. */
      kill: (target: InterventionTarget, reason: string) =>
        commanded(
          Effect.gen(function* () {
            const task = yield* prog.show(target.task.id);
            if (task.status === "done" || task.status === "canceled" || !target.worker) return;
            const note = reason.trim() || "operator killed this attempt";
            yield* stopAgents(target.worker);
            yield* prog.release(task.id);
            yield* prog.log(task.id, `foreman: operator killed this attempt: ${note}`);
            yield* teardown(task);
          }),
        ),

      /**
       * Salvages the uncommitted work in one project, so it can be dispatched
       * to again. Offered for any held project, including one being edited
       * right now: only the operator knows whether they have stepped away.
       */
      onboard: (project: string) =>
        commanded(
          Effect.gen(function* () {
            const found = projectFor(project);
            if (found) yield* onboard(found);
          }),
        ),

      /**
       * Starts a queued task's author now, on the rung the tick would choose or
       * on the one named. A named rung is the operator's choice for this one
       * dispatch and writes no label, so the task's evidence is unchanged.
       */
      author: (task: ReadyTask, rungName: string | undefined) =>
        commanded(
          Effect.gen(function* () {
            const rung =
              rungName === undefined
                ? yield* rungNow(task)
                : settings.ladder.find((candidate) => candidate.name === rungName);
            if (rung) yield* authorAt(task, rung);
          }),
        ),

      /**
       * The prompt a role would be sent on this task, rendered against the
       * worktree a fresh dispatch opens. `undefined` when the task is in no
       * managed project, or when a review has no branch to diff yet.
       */
      prompt: (role: AgentRole, id: string) =>
        Effect.gen(function* () {
          const task = yield* prog.show(id);
          const project = projectFor(task.project);
          if (!project) return undefined;
          const worktree = directoryFor(task.project, task.id);
          if (role === "author") {
            return yield* prompts.author(
              task,
              worktree,
              project.directory,
              project.verificationSkill,
            );
          }
          const base = yield* repository.base(project.directory, labelFor(task.id));
          if (!base) return undefined;
          return yield* prompts.review(
            task,
            worktree,
            project.directory,
            base,
            project.verify,
            project.verificationSkill,
          );
        }),

      /** Starts a fresh agent on a task whose worker vanished. */
      retry: (task: Item) =>
        commanded(
          Effect.gen(function* () {
            // A dispatch that failed is not a claim: the failure happened
            // before the claim, so the task is still open (or still reviewing,
            // when the review dispatch failed). Retrying clears the failure and
            // dispatches fresh, which claims it on the way; a failed retry
            // starts the tally over instead of resurrecting the old one. The
            // threshold, not mere presence, is the test: a task can carry a
            // single remembered failure and still be claimed, and that is an
            // author to retry, not a dispatch to re-attempt.
            if (((yield* Ref.get(dispatchFailures)).get(task.id)?.count ?? 0) >= 2) {
              yield* clearFailure(task.id);
              if (isOnboarding(task)) {
                const project = projectFor(task.project);
                if (project) {
                  yield* dispatchOnboard(task, project).pipe(
                    Effect.catch((error) => recordFailure(task.id, error)),
                  );
                }
                return;
              }
              if (task.status === "reviewing") {
                return yield* dispatchReview(task, authoredBy(task)).pipe(
                  Effect.catch((error) => recordFailure(task.id, error)),
                );
              }
              return yield* dispatchAuthor(task).pipe(
                Effect.catch((error) => recordFailure(task.id, error)),
              );
            }

            if (task.status === "reviewing") {
              return yield* dispatchReview(task, authoredBy(task));
            }

            // A salvage run that stopped is retried as a salvage run. Sending an
            // author into a worktree would show it a copy of the last commit,
            // which is precisely the state that has none of the work in it.
            if (isOnboarding(task)) {
              const project = projectFor(task.project);
              if (project) yield* dispatchOnboard(task, project);
              return;
            }

            const project = projectFor(task.project);
            if (!project) return;
            const rung = yield* rungNow(task);
            if (!rung) return;
            // The workspace may be gone — the pane that was its only one closed
            // by hand. `fleet.open` resolves to the worktree git still has, so
            // a retry re-adopts the same directory with its edits instead of
            // losing them.
            const worker = yield* workspaceFor(task, project);
            const prompt = yield* prompts.author(
              task,
              worker.directory,
              project.directory,
              project.verificationSkill,
            );
            const agent = yield* fleet.spawn(worker, spawnAs(rung, prompt, "author"));
            yield* prog.attribute(task.id, rung.name);
            yield* prog.log(task.id, agentLog("author", rung, agent));
          }),
        ),

      /** Hands a task back to the queue and takes its workspace down. */
      release: (task: Item) =>
        commanded(
          Effect.gen(function* () {
            yield* prog.release(task.id);
            yield* teardown(task);
          }),
        ),

      /**
       * Takes down a workspace whose task nothing owns.
       *
       * The orphaned-workspace decision is residue from a failed dispatch: the
       * task is neither claimed nor under review, so closing the workspace is
       * the whole answer. Releasing instead would reopen a done or canceled
       * task, and the branch survives either way — the sweep prunes a merged
       * one and the stranded column shows the rest.
       *
       * Named by the workspace rather than the task, because a workspace whose
       * task the store has deleted is closed the same way and has no task to
       * name it by.
       */
      close: (workspace: CloseOptions) => commanded(fleet.close(workspace)),

      /** Closes a queued task without creating a workspace or landing code. */
      complete: (task: ReadyTask, reason: string) =>
        commanded(
          prog
            .log(task.id, `foreman: marked done from queue: ${reason}`)
            .pipe(Effect.andThen(prog.complete(task.id))),
        ),

      diagnose: (target: InterventionTarget, intent: DiagnosticIntent, rung: string) =>
        commanded(dispatchDiagnostic(target, intent, rung)),

      reviewIntervention: (target: InterventionTarget, diagnosticRung: string | undefined) =>
        commanded(
          Effect.gen(function* () {
            const task = yield* prog.show(target.task.id);
            if (yield* branchCommitted(task)) return yield* dispatchFormalReview(target);
            if (diagnosticRung) yield* dispatchDiagnostic(target, "review", diagnosticRung);
          }),
        ),

      continueAt: (target: InterventionTarget, rung: string) =>
        commanded(dispatchContinuation(target, rung)),

      /** Moves a task one rung up the ladder for its next dispatch. */
      climb: (task: Climbing) => commanded(climb(task)),

      /** Moves a task one rung down the ladder, correcting an unearned climb. */
      descend: (task: Climbing) => commanded(descend(task)),

      /**
       * Clears a review-by:* label no reviewer is behind, at the operator's
       * word.
       *
       * The world records whether a reviewer was dispatched, not whether that
       * reviewer is still alive, so only the operator can say the label is
       * stale — the dashboard offers this exactly where the workspace is gone
       * and the task is open. An `approved` label on an open task is as stale
       * as the reviewer behind it: nothing is awaiting landing, and the task
       * is going to change hands. Liveness is the view's call; the label is
       * re-checked here only so an already-cleared snapshot clears nothing,
       * and it is cleared through the same method the settle loop uses when a
       * review ends.
       */
      unassign: (task: Climbing) =>
        commanded(
          Effect.gen(function* () {
            if (reviewedBy(task) === undefined) return;
            yield* prog.clearReview(task.id);
          }),
        ),

      /**
       * Pins a task to the front of the queue, or takes the pin off.
       *
       * The task is re-read before the label is flipped, because the view's
       * reading is up to a poll interval old and a pin the operator already
       * set from elsewhere would otherwise be cleared by a key meant to set
       * it.
       *
       * A pin on a task, unlike one on an epic, names only itself — the
       * descendant walk finds nothing under a task. The dashboard lists no
       * epics, so pinning one is still a `prog label` by hand.
       */
      togglePin: (task: string) =>
        commanded(
          Effect.gen(function* () {
            const current = yield* prog.show(task);
            yield* prog.setPin(task, !isPinned(current));
            yield* Effect.logInfo(`${isPinned(current) ? "unpinned" : "pinned"} ${task}`);
          }),
        ),

      /**
       * Puts an unread branch in front of a reviewer.
       *
       * Nobody can say from the outside whether commits nothing is reading are
       * worth keeping, and that judgement is exactly a review. The task moves
       * to `reviewing`, the next tick's review pass dispatches a reviewer at
       * the ladder's rung, and it either approves — which lands the branch
       * through the ordinary gate — or returns it with findings. Writing the
       * status rather than spawning here is what keeps reviews ahead of new
       * work: the operator names the branch, and fill still decides the order.
       *
       * A branch whose task is gone is skipped: it has no id to dispatch
       * against, so it stays on the list until a person deals with it.
       */
      adopt: (branch: Unreviewed) =>
        commanded(
          branch.status === undefined
            ? Effect.void
            : prog.submit(branch.task).pipe(
                Effect.andThen(
                  prog.log(
                    branch.task,
                    `foreman: ${branch.branch} holds commits ${branch.project} never took, and nothing was going to read them. Sent for review to decide whether they are worth landing.`,
                  ),
                ),
                Effect.catch((error) =>
                  Effect.logWarning(`adopting ${branch.task} failed: ${error}`),
                ),
              ),
        ),
    } as const;
  }),
}) {
  static readonly Default = Layer.effect(this, this.make);
}

/** Selects work for the free slots without performing any dispatch side effects. */
export const dispatchesFor = (
  current: DispatchState,
  slots: number,
  authors = true,
  failed: ReadonlySet<string> = new Set(),
  stale: ReadonlySet<string> = new Set(),
): ReadonlyArray<PlannedDispatch> => {
  const busy = current.workers.filter(isBusy).length;
  let free = slots - busy;
  if (free <= 0) return [];

  const dispatches: Array<PlannedDispatch> = [];

  // A pin leads the review pass as well as the queue. Reviews are filled before
  // authors either way, so without this a pinned task could sit behind three
  // other reviews — which is the thing the operator pinned it to stop.
  const reviews = [
    ...current.review.filter(({ task }) => current.pinned.has(task.id)),
    ...current.review.filter(({ task }) => !current.pinned.has(task.id)),
  ];

  for (const { task, worker } of reviews) {
    if (free <= 0) break;
    if (current.held.some((held) => held.project === task.project)) continue;
    if (reviewedBy(task) !== undefined || failed.has(task.id) || stale.has(task.id)) continue;
    if (current.outOfQuota.has(task.id)) continue;
    if (worker && isBusy(worker)) continue;
    dispatches.push({ role: "review", task });
    free -= 1;
  }

  // `queue` already leads with the pinned scope, so authoring needs no notion
  // of a pin at all. Nothing is reserved and nothing is serialized: which
  // pinned tasks may run together is what the plan's blockers already say, and
  // `prog ready` has applied them before foreman sees the queue.
  for (const task of current.queue) {
    if (!authors) break;
    if (free <= 0) break;
    if (current.held.some((held) => held.project === task.project)) continue;
    if (failed.has(task.id) || current.outOfQuota.has(task.id)) continue;
    dispatches.push({ role: "author", task });
    free -= 1;
  }

  return dispatches;
};

const isBusy = (worker: Worker): boolean =>
  worker.state === "working" || worker.state === "blocked";

interface DispatchState {
  readonly workers: ReadonlyArray<Worker>;
  readonly outOfQuota: ReadonlySet<string>;
  readonly queue: ReadonlyArray<ReadyTask>;
  readonly pinned: ReadonlySet<string>;
  readonly held: ReadonlyArray<Held>;
  readonly review: ReadonlyArray<Active>;
}

type PlannedDispatch =
  | { readonly role: "review"; readonly task: Item }
  | { readonly role: "author"; readonly task: ReadyTask };

/**
 * A finished branch whose fate is landing rather than the ordinary settle path,
 * whatever its pane is doing.
 *
 * `reviewing` means the author stopped writing, not that the diff has been read:
 * an approving reviewer is the only thing that makes a branch landable. So the
 * verdict label is the whole question here, and no task size or priority routes
 * around it.
 */
export const awaitingLanding = (task: Item): boolean =>
  task.status === "reviewing" && isApproved(task);

/**
 * Whether an author that handed off has waited too long to be worth keeping.
 *
 * Its pane outlives the handoff so a reviewer can send one mechanical finding
 * back to the session that holds the context, but that is a second resident
 * model per task in review, and a review backlog would otherwise keep one for
 * every task in it. Past the window foreman closes the pane and the reviewer
 * loses the option.
 *
 * The handoff is the last thing written to the task, so the wait is derivable
 * from the store and foreman still counts nothing of its own.
 */
export const handoffExpired = (task: Item, cutoff: DateTime.Utc): boolean =>
  DateTime.isLessThan(DateTime.fromDateUnsafe(task.last_activity_at), cutoff);

/**
 * A finished branch foreman may merge on this tick.
 *
 * Liveness belongs in the predicate rather than in a check beside it, because
 * the two filters in settle must agree about the same task. An agent that has
 * handed its work back still has a turn to finish — a closing message, a last
 * prog call — and landing ends by closing the workspace, which for a worktree
 * worker runs `worktree remove --force` and deletes the directory out from
 * under a running process. Status and verdict are both durable, so waiting one
 * tick costs nothing and loses nothing.
 */
export const readyToLand = (task: Item, worker: Worker | undefined): boolean =>
  awaitingLanding(task) && (worker === undefined || worker.state !== "working");

/**
 * What the dashboard must ask about.
 *
 * Three kinds, and each answers differently. A claimed task with a by-* label
 * and an empty workspace is an author that vanished and can be retried; a
 * reviewing task with a review-by:* label and an empty workspace is a reviewer
 * that vanished mid-verdict; a workspace whose task is neither claimed nor
 * under review is residue — the task is unclaimed, so nobody owns the
 * workspace — and the only answer is to close it.
 *
 * Residue is only asked about when foreman cannot prove it is spent, and a role
 * is that proof: dispatch opens a workspace, claims the task, and only then
 * spawns the agent that labels the pane, so a role on an unclaimed task's
 * workspace means the claim happened and was given up — settle sweeps those. A
 * workspace with no role is either a dispatch in flight, which resolves itself
 * within the tick, or one that died between opening and spawning, which nothing
 * else clears if the task is never offered again.
 */
export const decisionsOf = (
  claimed: ReadonlyArray<Active>,
  reviewing: ReadonlyArray<Active>,
  owned: ReadonlyArray<Owned>,
): ReadonlyArray<Active> => [
  ...claimed.filter(
    ({ task, worker }) =>
      authoredBy(task) !== undefined && (worker === undefined || worker.state === "gone"),
  ),
  ...reviewing.filter(
    ({ task, worker }) =>
      reviewedBy(task) !== undefined &&
      // A reviewer that wrote its verdict did not vanish, it finished: the task
      // waits on the checkout being clean, not on an answer, and its pane is
      // gone precisely because there was nothing left for it to do.
      !awaitingLanding(task) &&
      (worker === undefined || worker.state === "gone"),
  ),
  ...owned.filter(
    ({ task, worker }) =>
      task.status !== "in_progress" && task.status !== "reviewing" && worker.roles.size === 0,
  ),
];

/**
 * A dispatch failure, remembered between ticks so a repeat can be told from a
 * first failure.
 *
 * Only the detail and the count: which error, and how many times it has
 * repeated. Two with the same detail is the point at which the task stops
 * being offered and becomes a decision.
 */
export interface DispatchFailure {
  readonly detail: string;
  readonly count: number;
}

/**
 * What one dispatch failure means, from the failures already tallied.
 *
 * The first failure is news and is logged. The second identical failure is a
 * decision: logged once with the count, and from there the task is held out of
 * the queue rather than re-attempted. A different failure resets the tally —
 * it is a new fact, not a repeat. Further identical failures are quiet, since
 * nothing has changed to report.
 */
export type FailureReport = "first" | "repeat" | "quiet";

export const nextFailure = (
  failures: ReadonlyMap<string, DispatchFailure>,
  task: string,
  detail: string,
): {
  readonly failures: Map<string, DispatchFailure>;
  readonly count: number;
  readonly report: FailureReport;
} => {
  const prior = failures.get(task);
  const same = prior !== undefined && prior.detail === detail;
  const count = same ? prior.count + 1 : 1;
  const report: FailureReport = !same ? "first" : count === 2 ? "repeat" : "quiet";
  return { failures: new Map(failures).set(task, { detail, count }), count, report };
};

/**
 * The tasks whose dispatch has failed at least twice with the same error.
 *
 * These are held out of the queue and surfaced as decisions instead of being
 * re-attempted every tick.
 */
export const failedTasks = (
  failures: ReadonlyMap<string, DispatchFailure>,
): ReadonlyArray<readonly [string, DispatchFailure]> =>
  [...failures].filter(([, failure]) => failure.count >= 2);

/** Keeps a failed task in decisions, not in the ordinary queue. */
export const excludeFailedTasks = <Task extends { readonly id: string }>(
  tasks: ReadonlyArray<Task>,
  failures: ReadonlyArray<readonly [string, DispatchFailure]>,
): ReadonlyArray<Task> => {
  const failedIds = new Set(failures.map(([task]) => task));
  return tasks.filter((task) => !failedIds.has(task.id));
};

/**
 * The statuses from which a task still reaches an agent on its own.
 *
 * `open` is the queue, which resumes the branch rather than reading it, and
 * orders by age already. `in_progress` is a claim — worked, or vanished and
 * therefore a decision, and reclaimed back to `open` when it goes stale.
 * `reviewing` is the review pass. Every one of them ends with the branch read.
 */
const REACHABLE: ReadonlySet<string> = new Set(["open", "in_progress", "reviewing"]);

/**
 * Whether a branch holds commits that nothing is ever going to pick up.
 *
 * Every other column is read from prog, which stops mentioning a branch the
 * moment its task is closed, reclaimed or deleted — while the commits stay. So
 * this asks the branches, and two facts answer it.
 *
 * `merged` is the whole test for holding commits the checkout has not taken. An
 * untouched branch still points at the trunk commit it was cut from, so it is
 * reachable from `HEAD` and merged by definition; nothing empty survives here.
 *
 * The status is the whole test for whether anything will reach it. This is a
 * narrower question than "has anyone reviewed this", deliberately: a task in
 * the queue with commits behind it is not abandoned, it is next in line, and
 * the queue is already the bucket that works oldest first. Listing those would
 * name the ordinary case as an exception — and dispatching a reviewer at one
 * would read a diff its author is half way through.
 *
 * What is left is work that has fallen out of every mechanism foreman has: a
 * task marked done whose branch never landed, one canceled with commits still
 * on it, and one deleted outright, which has no status at all.
 */
export const isUnread = (branch: {
  readonly merged: boolean;
  readonly status: string | undefined;
}): boolean => !branch.merged && !REACHABLE.has(branch.status ?? "");

/**
 * How long an unread branch has been waiting, for the oldest-first order.
 *
 * A branch whose task is gone has no activity to read and sorts first: it is
 * the one nothing can recover on its own, so it is the one an operator should
 * see at the top rather than under everything foreman is already handling.
 */
export const waiting = (branch: { readonly activity: Date | undefined }): number =>
  branch.activity?.getTime() ?? 0;

/**
 * Whether foreman may put an unread branch back in front of a reviewer itself.
 *
 * `done` is the one status where it can. It says the task finished, so the
 * branch was work somebody meant to keep, and unmerged commits behind it mean
 * a landing that never completed — a state foreman's own pipeline produced and
 * can therefore correct without asking.
 *
 * `canceled` is not the same answer wearing a different word. Somebody decided
 * that work should not happen, and an automatic review would spend a rung
 * relitigating the decision; those branches are shown and left. A deleted task
 * has no id to dispatch against at all.
 */
export const recoverable = (branch: { readonly status: string | undefined }): boolean =>
  branch.status === "done";

/**
 * Shapes the dashboard's landed column out of every done task prog returns.
 *
 * prog list has no limit and no order foreman can rely on — it comes back
 * grouped by project in config order — so the window is applied here and the
 * survivors are put in landing order. `last_activity_at` is when a done task
 * was last touched, which for a done task is when it landed.
 */
export const landedColumn = (
  landed: ReadonlyArray<Item>,
  now: DateTime.DateTime,
  windowDays: number,
): ReadonlyArray<Item> => {
  const cutoff = DateTime.subtract(now, { days: windowDays });
  return landed
    .filter((item) =>
      DateTime.isGreaterThan(DateTime.fromDateUnsafe(item.last_activity_at), cutoff),
    )
    .sort((first, second) => second.last_activity_at.getTime() - first.last_activity_at.getTime());
};

/**
 * Splits work handed back for review by whether there is any work in it.
 *
 * Two proofs are needed, and prog can only give one. The `by-*` label proves
 * foreman authored the branch; only a commit on that branch proves the author
 * produced something. An agent can move a task to `reviewing` having written
 * nothing, and then a reviewer is paid to read an empty diff — or, on a task
 * small enough to skip review, an empty merge commit lands.
 *
 * `committed` holds the tasks whose branch carries commits of its own, which is
 * the same read that finds unread branches. Of its own, not merely of ones
 * the checkout lacks: a branch already merged — by foreman on an earlier tick,
 * or by hand — proves its author wrote something just as well, and reading that
 * as an empty branch sends finished work back to the queue.
 *
 * Two empty branches are worth a reviewer. One is the author's claim that the
 * trunk already does what the task asks — a finding about the codebase rather
 * than an absence of work, and the only ending that closes a task the backlog
 * has outlived. The other is a task labelled `research`, whose deliverable is a
 * report in the task log rather than commits. Both are claims, not verdicts:
 * the reviewer confirms the satisfied one against the trunk and the research
 * one against its evidence, and an ordinary rejection sends a false one back.
 */
export const reviewable = (
  reviewing: ReadonlyArray<Active>,
  committed: ReadonlySet<string>,
): { readonly review: ReadonlyArray<Active>; readonly unbacked: ReadonlyArray<Active> } => {
  const authored = reviewing.filter(({ task }) => authoredBy(task) !== undefined);
  const readable = ({ task }: Active) =>
    committed.has(task.id) || isSatisfied(task) || isResearch(task);
  return {
    review: authored.filter(readable),
    unbacked: authored.filter((active) => !readable(active)),
  };
};

/**
 * The workspaces this daemon owns, out of a roster that shows every daemon's.
 *
 * The fleet lists every task's workers whoever started them, and the
 * label records no ownership — two foremen against different configs are not
 * competing for the same slots, and a workspace opened by hand in the same
 * namespace belongs to neither. The checkout a workspace's worktree belongs to
 * is what the config's project set scopes, and the fleet reports it, so this is
 * settled before the store is asked anything.
 *
 * The checkout rather than the task's project, because the checkout is what
 * foreman acts on — worktree, branch, landing — and it is still there after
 * the task is deleted, which is when ownership most needs an answer. A
 * workspace with no worktree at all has no checkout to be scoped by and is
 * therefore nobody's: foreman never opens one.
 */
export const ours = (
  roster: ReadonlyArray<Worker>,
  checkouts: ReadonlySet<string>,
): ReadonlyArray<Worker> =>
  roster.filter((worker) => worker.repository !== undefined && checkouts.has(worker.repository));

/**
 * The workspaces this daemon may act on, split out of a roster that shows
 * every daemon's.
 *
 * The caller has already scoped the roster to the checkouts the config names,
 * which is the ownership the world records. What is left here is the join to
 * the store: a workspace whose task the store denies is an orphan the caller
 * surfaces, and it must not eat a slot nothing will ever free.
 *
 * Both shapes come back from the same pass so they cannot disagree: `owned` is
 * what settle and the dashboard may touch, and `workers` is the roster shape
 * slots are counted from.
 */
export const scopeRoster = (
  roster: ReadonlyArray<Worker>,
  tasks: ReadonlyMap<string, Item>,
): { readonly owned: ReadonlyArray<Owned>; readonly workers: ReadonlyArray<Worker> } => {
  const owned: Array<Owned> = [];
  const kept = new Set<string>();
  for (const worker of roster) {
    const task = tasks.get(worker.task);
    if (!task) continue;
    kept.add(worker.task);
    const state = reviewedBy(task) ? worker.roles.get("review") : worker.roles.get("author");
    owned.push({
      task,
      worker: { ...worker, state: state ?? "gone" },
      kind: reviewedBy(task) ?? authoredBy(task),
    });
  }
  return { owned, workers: roster.filter((worker) => kept.has(worker.task)) };
};

/**
 * What a climb reads off a task: which rung it is on, and how to name it.
 *
 * Written structurally because both a queued task and a claimed one climb, and
 * they are different shapes — a queued task has no status yet.
 */
export interface Climbing {
  readonly id: string;
  readonly title: string;
  readonly labels: ReadonlyArray<string>;
}

/** A rung, as the multiplexer needs it: which program, and which model inside it. */
const spawnAs = (rung: Rung, prompt: string, role: AgentRole): SpawnOptions => ({
  kind: rung.harness,
  model: rung.model,
  thinking: rung.thinking,
  prompt,
  role,
});

/**
 * How much work the fleet may take on, which is the operator's intention and
 * so the one thing foreman holds in memory rather than reading back.
 *
 * `draining` is the state between the other two, and it is the useful one for
 * aiming the fleet by hand: the author pass is skipped while reviews,
 * landings, settles and the sweep all continue, so the pipeline empties itself
 * instead of freezing with approved branches unlanded.
 */
export type Dispatch = "running" | "draining" | "paused";

/**
 * The next state the operator's key gives them, narrowest last.
 *
 * One key rather than one per state, because the three are one continuum —
 * how much the fleet is taking on — and a second key would have to say which
 * of the two it overrides.
 */
export const nextDispatch = (mode: Dispatch): Dispatch =>
  mode === "running" ? "draining" : mode === "draining" ? "paused" : "running";

/** Everything the dashboard draws, and everything the loop decided from. */
export interface FleetState {
  /** In-progress epics and their direct-child progress, shown above queue tasks. */
  readonly epics: ReadonlyArray<EpicProgress>;
  /** Ready work in dispatch order: the pinned scope first, then everything else. */
  readonly queue: ReadonlyArray<ReadyTask>;

  /**
   * The task ids the operator has pinned, including those reached through a
   * pinned epic.
   *
   * One set beside one queue rather than two lists, because everything a
   * caller wants — which rows to mark, how many are ready, where the pinned
   * run ends — is derivable from the two, and a second list is a second thing
   * to keep in step.
   */
  readonly pinned: ReadonlySet<string>;

  /**
   * Tasks parked at the operator's rung, above the last model in the ladder.
   *
   * They arrive by climbing off the top — nothing configured could finish them
   * — or by being pinned there by hand, which is what work that was never
   * specified needs: dispatching it once to discover that wastes a run. Either
   * way the answer is a person writing the decision into the task and then
   * removing the label.
   */
  readonly yours: ReadonlyArray<ReadyTask>;
  readonly working: ReadonlyArray<Active>;
  readonly review: ReadonlyArray<Active>;
  readonly landed: ReadonlyArray<Item>;
  readonly decisions: ReadonlyArray<Active>;
  readonly committed: ReadonlySet<string>;
  readonly resumable: ReadonlySet<string>;

  /**
   * Branches holding commits the project never took, that no reviewer is
   * going to read on its own.
   */
  readonly unreviewed: ReadonlyArray<Unreviewed>;

  /**
   * Branches whose task is under review but that the trunk has moved past, so
   * a review of them could never be applied.
   *
   * The review pass holds these tasks out — the branch is why — and the
   * operator decides what to do with the work. So this column is where the
   * fleet says "about to spend a review that cannot land", before it happens.
   */
  readonly stale: ReadonlyArray<StaleRow>;

  /**
   * Workspaces in a project foreman manages whose task the store no longer
   * has.
   *
   * A task can be deleted while its workspace is open, and after that nothing
   * in the pipeline mentions the workspace: no column shows it, no slot counts
   * it, and no tick will ever dispatch into it — so left alone it stays open
   * forever holding a worktree. Asked about rather than swept, because the
   * worktree may still hold uncommitted work and no task remains to record
   * what it was.
   */
  readonly orphans: ReadonlyArray<Worker>;

  /**
   * Projects whose checkout is not free to work against, and why.
   *
   * The operator is working there, or the checkout has no branch a landing
   * could move. Their tasks stay in the queue until the checkout is free
   * again. Naming them and the reason is the point: a queue that stops moving
   * for a cause nobody can see reads as a broken dispatcher.
   */
  readonly held: ReadonlyArray<Held>;

  /**
   * What each account behind the ladder has left of its allowance.
   *
   * Read from the providers themselves every tick, like everything else, and
   * held nowhere: an allowance is the world's fact, not foreman's. A provider
   * foreman could not reach is carried with `unreadable` set rather than
   * reported as spent, so the dashboard can say why it is absent while the
   * gate — and the empty `allowances` — treat it as neither spent nor a wall.
   *
   * On the state rather than derived in the view because it is what the gate
   * decided from: a fleet that stops dispatching must be able to show the same
   * numbers it stopped on.
   */
  readonly providers: ReadonlyArray<Provider>;
  readonly dispatch: Dispatch;

  /**
   * When this reading of the world was taken.
   *
   * The only thing foreman knows about its own progress. A tick reads the
   * world, publishes it, and only then acts on it — and acting can take
   * minutes, because landing runs the project's verification command. Nothing
   * else records that foreman is mid-verify rather than wedged, so the age of
   * this timestamp is that signal: it counts up while a tick works and resets
   * when the next one reads. Seconds mean a moving fleet, minutes mean a tick
   * inside something long. `undefined` before the first read completes.
   */
  readonly observedAt: DateTime.Utc | undefined;
}

/**
 * A branch carrying commits nobody has been sent to read.
 *
 * `title` and `status` are absent when the task itself is gone — the branch
 * prog has stopped tracking, which is why git is asked rather than prog. Such
 * a branch can be shown but not recovered: every workspace, prompt and merge
 * in foreman is addressed by task id, so there is nothing left to dispatch
 * against.
 */
export interface Unreviewed {
  readonly project: string;
  readonly branch: string;
  readonly task: string;
  readonly title: string | undefined;
  readonly status: string | undefined;
  /** When its task last moved, which is the order these are recovered in. */
  readonly activity: Date | undefined;
}

/**
 * A branch the trunk has overtaken, under a task that is still in review.
 *
 * The task rides whole because the operator acts on it — releasing it is what
 * sends the work back to the queue instead of paying for a review that could
 * never land. `paths` and `modifyDelete` are the fact `Branch.stale` carries,
 * so the row can say what a rebase would have to face.
 */
export interface StaleRow {
  readonly project: string;
  readonly branch: string;
  readonly task: Item;
  readonly paths: ReadonlyArray<string>;
  readonly modifyDelete: boolean;
}

/**
 * A project held out of the queue, with the reason it is held.
 *
 * `reason` is what the dashboard gates actions on — only a `dirty` hold has
 * uncommitted work for an onboarding agent to salvage. `detail` is what the
 * operator reads; it comes from the same probe the landing verdict reads, so
 * the two never disagree about why a checkout is busy.
 */
export interface Held {
  readonly project: string;
  readonly reason: HoldReason;
  readonly detail: string;
}

/**
 * One account behind the ladder, as the dashboard reads it.
 *
 * `Usage` is the probe's answer — what the provider says it has left. On top
 * of it the dispatcher adds the two things the probe never says: which rungs
 * draw on this account (read off the same ladder the gate reads), and why the
 * account could not be read at all when it could not. An unreadable account
 * carries empty `allowances`, so the gate's `exhausted` probe reads it as
 * neither spent nor a wall.
 */
export interface Provider extends Usage {
  readonly rungs: ReadonlyArray<string>;
  readonly unreadable: string | undefined;
}

/** A task and the workspace running it, if the multiplexer still has one. */
export interface Active {
  readonly task: Item;
  readonly worker: Worker | undefined;
  readonly kind: string | undefined;
  /** The error behind a dispatch-failed decision, absent for the other kinds. */
  readonly failure?: string;
}

export interface EpicProgress {
  readonly epic: Item;
  readonly children: ReadonlyArray<Item>;
}

export interface InterventionTarget {
  readonly task: Item | ReadyTask;
  readonly worker: Worker | undefined;
}

export interface Owned {
  readonly task: Item;
  readonly worker: Worker;
  readonly kind: string | undefined;
}

/**
 * Everything derived from one observation, for every consumer of it.
 *
 * An observation is what the sources said; this is what foreman makes of it.
 * Nothing here is read back from anywhere — a field that would need another
 * question asked belongs in the reading, not in what the reading implies.
 */
interface Interpretation extends FleetState {
  readonly workers: ReadonlyArray<Worker>;
  readonly owned: ReadonlyArray<Owned>;

  /**
   * Tasks whose next agent would run on an account with nothing left.
   *
   * Not part of `FleetState`: the dashboard shows the accounts themselves,
   * which is what an operator can act on, while this is the same reading
   * folded onto the tasks fill would otherwise have started.
   */
  readonly outOfQuota: ReadonlySet<string>;

  /**
   * Tasks handed back for review whose branch holds no commits.
   *
   * Not part of `FleetState`: settle returns each of these to the queue on the
   * same tick that finds it, so it is a step's input rather than anything the
   * dashboard could draw.
   */
  readonly unbacked: ReadonlyArray<Active>;

  /** The merged branches no live task still points at, for the sweep. */
  readonly prunable: ReadonlyArray<{
    readonly project: string;
    readonly directory: string;
    readonly branch: string;
  }>;
}

/** `1 slot`, `2 slots`. The supervised run AGENTS.md recommends is `--slots 1`. */
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const empty: FleetState = {
  epics: [],
  queue: [],
  pinned: new Set(),
  yours: [],
  working: [],
  review: [],
  landed: [],
  decisions: [],
  committed: new Set(),
  resumable: new Set(),
  unreviewed: [],
  stale: [],
  orphans: [],
  held: [],
  providers: [],
  // Before the first tick has read anything, and the state foreman starts in
  // unless the command line said otherwise.
  dispatch: "paused",
  observedAt: undefined,
};

interface Project {
  readonly name: string;
  readonly directory: string;
  readonly verificationSkill?: string;
}
