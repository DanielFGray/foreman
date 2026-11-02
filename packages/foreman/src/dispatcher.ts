import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Fiber,
  Match,
  Metric,
  Option,
  Path,
  Queue,
  Ref,
  Stream,
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
import {
  admit,
  expire,
  modeOf,
  permit,
  grant,
  policyPath,
  readPolicy,
  scopeOf,
  updatePolicy,
  type Permit,
  type Policy,
  type Scopes,
  type Step,
  DEFAULT_POLICY,
} from "./policy.ts";
import { queueFrom } from "./queue.ts";
import { phaseOf, type TaskPhase } from "./task-phase.ts";
import { Repository, RepositoryError, type Hold, type HoldReason } from "./repository.ts";
import { Quota, type Usage, walledRungs } from "./quota.ts";
import {
  authorFor,
  dispatchable as dispatchableRungs,
  rankOf,
  highestFailure,
  providersOf,
  providerOf,
  reviewerFor,
  type Rung,
  rungSpent,
  rungsOn,
  topOf,
} from "./ladder.ts";
import { authorWalls, rungAt } from "./agent-rung.ts";
import {
  nextAgent,
  place,
  routeWorkspace,
  type AgentNode,
  type CheckNode,
  type DoneNode,
  type Exit,
  type LandNode,
  type Pipeline,
  QUEUE,
  type Placement,
  type Workspace,
} from "./pipeline.ts";
import { factsOf } from "./pipeline-facts.ts";
import {
  pipelinesPath,
  projectPipeline,
  readPipelines,
  type ProjectPipeline,
} from "./pipeline-file.ts";
import {
  agentLog,
  attemptsOf,
  diagnosticIntent,
  type DiagnosticIntent,
  isOnboarding,
  isResearch,
  type Item,
  failuresOf,
  needsYou,
  ONBOARD,
  Prog,
} from "./prog.ts";
import {
  authoredBy,
  directBase,
  claimsAlreadyDone,
  reviewerNamed,
  lapOf,
  lastExit,
  routedCommit,
  reviewedBy,
  reviewFailedBy,
} from "./lap.ts";
import { hitWall } from "./harness.ts";
import { newRunFor } from "./run-record.ts";
import type { Ending, Run } from "tasks";
import { openCheckouts, type Project, projectSet } from "./projects.ts";

const runDuration = Metric.timer("foreman.run.duration", {
  description: "Time foreman spends dispatching one run, in milliseconds.",
  boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 20 }),
});

const runOutcomes = Metric.counter("foreman.run.outcomes", {
  description: "Settled agent runs by their closed task phase.",
  incremental: true,
});

/**
 * The task-log line a kill writes: the attempt note, plus the operator's
 * reason when one was given.
 *
 * Absence is carried as absence, so a kill with no reason writes the bare
 * attempt line, and a blank one writes it too — only real text earns a suffix.
 */
const killLogLine = (reason: Option.Option<string>): string => {
  const note = Option.getOrElse(reason, () => "").trim();
  const suffix = note === "" ? "" : `: ${note}`;
  return `foreman: operator killed this attempt${suffix}`;
};

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

    const state = yield* SubscriptionRef.make(EMPTY_FLEET);

    // The policy file is read and written from inside the loop, so its file
    // system is taken once here rather than required of every method.
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    // The one piece of in-process state: the world does not record foreman's own attempts. A dispatch
    // failure is only observed by trying, and the trying is what must stop —
    // the worktree that made `open` fail will still exist next tick, so a
    // second attempt learns nothing. Two identical failures move the task to a
    // decision instead of a third attempt. A restart forgets the tally, which
    // costs the dispatcher two attempts to relearn it; the tasks themselves stay
    // safe in the queue either way.
    const dispatchFailures = yield* Ref.make(new Map<string, DispatchFailure>());

    // Whether the accounts have been read at all yet. A fleet that has just
    // started has nothing to say about them, and "no reading" and "nothing
    // left" are not distinguishable on a dashboard — so the first tick asks
    // whatever the fleet is doing, and one that is not running then stops. One probe per
    // process, which is also what makes a restart show the accounts without
    // the operator having to start the fleet to see them.
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
     * Rewrites the policy file. A write that fails is logged and dropped: the
     * file is the operator's, and the worst a lost write costs is one grant
     * admitting a task it already admitted, or expiring a pass late.
     */
    const writePolicy = (change: (policy: Policy) => Policy) =>
      updatePolicy(policyPath(), change).pipe(
        Effect.provideContext(platform),
        Effect.asVoid,
        Effect.catchCause(Effect.logWarning),
      );

    /**
     * Puts the policy file's current contents into the published reading, and
     * says whether that changed it. A tick spends seconds reading the world,
     * and the operator's click should not wait for it: the policy is one local
     * file, so it is published on its own. The tick still reads the file itself
     * for the decisions it makes.
     */
    const publishPolicy = Effect.gen(function* () {
      const { policy, error } = yield* readPolicy(policyPath()).pipe(
        Effect.provideContext(platform),
      );
      const text = (p: Policy, e: string | undefined) => JSON.stringify([p, e]);
      const before = yield* SubscriptionRef.get(state);
      if (text(before.policy, before.policyError) === text(policy, error)) return false;
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        policy,
        policyError: error,
      }));
      return true;
    });

    /**
     * Publishes each change to the policy file as it happens, then wakes the
     * loop so the next tick acts on it. A change to the pipelines file only
     * wakes the loop, because every tick reads that file. The directory is
     * watched, not the files, because both are replaced by rename. A pipelines
     * file outside the policy's directory, and a watcher that cannot start,
     * cost only the delay: the poll still reads both files.
     */
    const watchPolicy = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const file = policyPath();
      const drawn = paths.basename(pipelinesPath());
      yield* fs.makeDirectory(paths.dirname(file), { recursive: true });
      yield* fs.watch(paths.dirname(file)).pipe(
        Stream.runForEach((event) => {
          const name = paths.basename(event.path);
          if (name === paths.basename(file)) {
            return publishPolicy.pipe(Effect.flatMap((changed) => (changed ? nudge : Effect.void)));
          }
          return name === drawn ? nudge : Effect.void;
        }),
      );
    }).pipe(
      Effect.provideContext(platform),
      Effect.catchCause((cause) => Effect.logWarning("policy watcher stopped", cause)),
    );

    /** Records that each grant among `permits` took on a task, once the step they allowed has run. */
    const admitted = (permits: ReadonlyArray<Permit>, task: string) => {
      const grants = permits.flatMap((given) =>
        given._tag === "Granted" && given.admits ? [given.scope] : [],
      );
      return grants.length === 0
        ? Effect.void
        : writePolicy((policy) => grants.reduce((next, scope) => admit(next, scope, task), policy));
    };

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
      // Asked at all only where the answer has a consumer. A fleet that is not
      // running dispatches nothing, so no gate reads an allowance, and the
      // spent accounts in attention are not what stopped it — the policy is,
      // and the published reading already says so. Probing on regardless is a
      // network request every poll to explain a halt that has another cause.
      // The policy is the previous reading's: a pause takes one poll to stop
      // the probes, and the probe is all that lags.
      const previousPolicy = (yield* SubscriptionRef.get(state)).policy;
      const wanted = modeOf(previousPolicy) === "running" || !(yield* Ref.get(everProbed));
      if (wanted) yield* Ref.set(everProbed, true);
      const probing = yield* Effect.forkChild(
        wanted ? readProviders : Effect.succeed<ReadonlyArray<Provider>>([]),
      );
      const observation = yield* observe;
      // A tick that did not ask carries the last answer rather than publishing
      // an empty set, because "not read" and "no accounts" look identical on a
      // dashboard and only one of them is true. Carried for the view alone:
      // the gate that reads an allowance runs only while the fleet is
      // running, and a running fleet probes on every tick, so no
      // dispatch is ever decided from a reading this line kept.
      const previous = yield* SubscriptionRef.get(state);
      const providers = wanted ? yield* Fiber.join(probing) : previous.providers;

      const current = yield* interpret(observation, providers);
      yield* SubscriptionRef.set(state, current);
      // The file may have changed after this reading took its copy; the
      // watcher already published that change, and this set replaced it.
      yield* publishPolicy;
      return { current, providers };
    });

    /**
     * Reads the whole world and works out what to do about it.
     *
     * A fleet that is not `running` stops after the reading. Every pass below
     * can write to the task store, git or the multiplexer, and a paused or
     * idle fleet must write nothing: the operator stops the fleet to look at
     * the world without it moving, and a step nobody allowed is not foreman's
     * to take.
     *
     * Order matters. The plan takes the tasks nearest the end of their
     * pipeline first (fewest work blocks left), then in queue order. In the
     * standard pipeline that dispatches reviews before new work: a task waiting
     * to be reviewed is nearly finished and is blocking whatever depends on it,
     * whereas an unclaimed task has not started costing anything yet. Filling
     * slots with new work while reviews pile up is how a queue grows a
     * permanent tail of almost-done tasks.
     */
    const tick = Effect.gen(function* () {
      const { current, providers } = yield* read;
      if (modeOf(current.policy) !== "running") return;
      yield* settle(current);
      yield* tidy(current);
      yield* reclaim(current);
      yield* recover(current);
      // The second reading is narrow, not stale. The passes above write to the
      // store and to git, so what fill decides from has to be read after them —
      // but a dispatch turns on ten fields, and the columns only a person reads
      // cost a store read per branch and a `git status` per worktree to build.
      // Reading them again here would be work whose one consumer is the
      // discard.
      yield* fill(yield* readDispatch(providers));
      // A grant with nothing left to cover is removed, so the file says only
      // what still holds.
      if (current.policy.grants.length > 0) {
        yield* writePolicy((policy) => expire(policy, current.scopes));
      }
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
      // The roster is every dispatcher's: the fleet lists every task's workers
      // whoever started them, and a label records no ownership — two
      // foremen against different configs are not competing for the same
      // slots. The checkout a workspace's worktree belongs to is what the
      // config's project set scopes, and the fleet reports it, so ownership is
      // settled before the store is asked anything. Scoping by the task's
      // project instead means one store read per workspace on the machine
      // before knowing whether any of them is this dispatcher's — and it cannot
      // classify a workspace whose task has been deleted at all.
      const everyone = yield* fleet.roster;
      const { projects, ambiguous } = yield* resolveProjects(everyone);
      const open = new Set(projects.filter((project) => project.open).map((p) => p.name));
      const roster = ours(everyone, new Set(projects.map((project) => project.directory)));

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

      // The operator's policy, read every pass so an edit takes effect on the
      // next one.
      const { policy, error: policyError } = yield* readPolicy(policyPath()).pipe(
        Effect.provideContext(platform),
      );

      // Each checkout's tip and whether it has uncommitted changes. A task that
      // works in the operator's checkout starts only from a clean tree, and a
      // task on the operator's own branch reads its work at that tip. A
      // checkout that cannot answer reads as dirty, so nothing starts there.
      const checkoutStates = yield* Effect.forEach(projects, (project) =>
        Effect.all([repository.dirty(project.directory), repository.head(project.directory)]).pipe(
          Effect.map(([dirty, head]) => ({ project: project.name, dirty, head })),
          Effect.orElseSucceed(() => ({
            project: project.name,
            dirty: true,
            head: undefined as string | undefined,
          })),
        ),
      );
      const dirty: ReadonlySet<string> = new Set(
        checkoutStates.filter((entry) => entry.dirty).map((entry) => entry.project),
      );
      const heads = new Map(checkoutStates.map((entry) => [entry.project, entry.head] as const));

      // Which checkouts the operator is presently working in. Read every tick
      // like everything else: you clean a tree up between two ticks and the
      // project comes back on its own. The reason rides along, because a hold
      // that clears itself and one that needs a hand-run command must not read
      // the same on the dashboard.
      const checkouts = yield* Effect.forEach(projects, (project) =>
        repository.isFree(project.directory).pipe(
          Effect.map((result: Hold): ReadonlyArray<Held> =>
            result._tag === "Clean"
              ? []
              : [
                  {
                    project: project.name,
                    reason: result.reason,
                    detail: result.detail,
                    ...(result.branch === undefined ? {} : { branch: result.branch }),
                  },
                ],
          ),
          // A checkout foreman cannot read is a checkout it must not merge
          // into either, so an unreadable repository is held rather than free.
          Effect.catch((error: RepositoryError) =>
            Effect.logWarning(`holding ${project.name}: ${error}`).pipe(
              Effect.as<ReadonlyArray<Held>>([
                {
                  project: project.name,
                  reason: "unreadable",
                  detail: error.detail,
                },
              ]),
            ),
          ),
        ),
      ).pipe(
        Effect.map((rows) => rows.reduce<ReadonlyArray<Held>>((all, row) => [...all, ...row], [])),
      );
      // Tasks name a project, not a directory, so a name two checkouts share
      // is held rather than guessed at; closing one of the spaces resolves it.
      const checkoutHolds: ReadonlyArray<Held> = [
        ...checkouts,
        ...ambiguous.map((one): Held => ({
          project: one.name,
          reason: "ambiguous",
          detail: `two checkouts are named ${one.name}: ${one.directories.join(", ")}`,
        })),
      ];

      const claimed = yield* eachProject(projects, (project) => prog.claimed(project.name));
      const reviewing = yield* eachProject(projects, (project) =>
        prog.awaitingReview(project.name),
      );
      // One query, gated by prog: `ready` returns a task only once every task
      // blocking it is done, whichever project that blocker lives in. The
      // allowlist is applied afterwards, to prog's answer rather than to the
      // question, so a blocker outside the fleet still holds its dependents.
      const queue = yield* prog.ready(Option.none());
      const epics = yield* prog.epicsOver(queue);

      // Each project's pipeline, read with the policy and checked against the
      // ladder on every pass: a ladder edit can make a drawing invalid.
      const drawings = yield* readPipelines(pipelinesPath()).pipe(Effect.provideContext(platform));
      const rungs = settings.ladder.map((rung) => rung.name);
      const pipelines: ReadonlyMap<string, ProjectPipeline> = new Map(
        projects.map((project) => [project.name, projectPipeline(drawings, project.name, rungs)]),
      );
      const scopes: Scopes = new Map(
        yield* Effect.forEach(policy.grants, (grant) =>
          prog.lookup(grant.scope).pipe(
            Effect.flatMap((item) =>
              Option.isSome(item)
                ? scopeOf([item.value], (id) => prog.children(id))
                : Effect.succeed<ReadonlySet<string>>(new Set()),
            ),
            Effect.map((tasks) => [grant.scope, tasks] as const),
          ),
        ),
      );

      // Foreman's branches, in every project. One read, three questions: which
      // branches nothing in the pipeline accounts for, whether a task handed
      // back for review has anything on it, and which refs the sweep may
      // delete. They were three reads once, and the answers disagreed.
      const branches = yield* eachProject(projects, (project) =>
        repository.branches(project.directory).pipe(
          Effect.map((refs) =>
            refs.flatMap((ref) => {
              const task = taskOf(ref.branch);
              return task
                ? [
                    {
                      ...ref,
                      project: project.name,
                      directory: project.directory,
                      task,
                    },
                  ]
                : [];
            }),
          ),
        ),
      );

      // An approval is bound to the commit the reviewer read, so every task
      // carries the tip its work has in this reading: its branch's, or, for a
      // task on the operator's own branch, the checkout's while it occupies it.
      const tips = new Map(branches.map((entry) => [entry.task, entry.tip] as const));
      // A task that works in the checkout holds it against every other task
      // (rule 2 of docs/workspace-blocks.md), as a `busy` hold that names it. A
      // branch-only task's branch out in the checkout already reads as one.
      const occupancy: ReadonlyArray<Held> = [...claimed, ...reviewing, ...queue]
        .filter((task) => occupies(pipelines, task))
        .filter(
          (task) =>
            !checkoutHolds.some(
              (entry) => entry.project === task.project && entry.branch === labelFor(task.id),
            ),
        )
        .map((task) => ({
          project: task.project,
          reason: "busy",
          detail: `${task.id} works in the checkout until it leaves the pipeline`,
          branch: labelFor(task.id),
        }));

      const withTip = (task: Item): Item => ({
        ...task,
        tip:
          workspaceOf(pipelines, task) === "none"
            ? occupies(pipelines, task)
              ? heads.get(task.project)
              : undefined
            : tips.get(task.id),
      });

      return {
        projects,
        open,
        readings: readings.map(({ worker, task }) => ({
          worker,
          task: Option.map(task, withTip),
        })),
        roster,
        held: [...checkoutHolds, ...occupancy],
        claimed: claimed.map(withTip),
        reviewing: reviewing.map(withTip),
        epics,
        queue: queue.map(withTip),
        policy,
        policyError,
        pipelines,
        scopes,
        branches,
        dirty,
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
        projects,
        open,
        readings,
        roster,
        held,
        claimed,
        reviewing,
        epics,
        queue,
        policy,
        policyError,
        pipelines,
        scopes,
        branches,
        dirty,
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
      // A task on the operator's own branch has no branch of its own: its
      // author wrote something when the tip moved past the commit it started from.
      const committed = new Set([
        ...branches.filter((entry) => !entry.empty).map((entry) => entry.task),
        ...[...claimed, ...reviewing]
          .filter(
            (task) =>
              workspaceOf(pipelines, task) === "none" &&
              task.tip !== undefined &&
              task.tip !== directBase(task),
          )
          .map((task) => task.id),
      ]);

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
            first.task.lastActivityAt.getTime() - second.task.lastActivityAt.getTime(),
        );

      // What the sweep may delete: a merged ref for work nothing in the
      // pipeline is still pointing at. The branch is a task's only proof that
      // its author wrote anything, and a merge can arrive from outside foreman
      // — a hand-merged branch swept on the tick before its reviewer settles
      // leaves that task looking like one nobody ever committed to. A task the
      // fleet still accounts for is never swept: the queue will dispatch onto
      // that same branch, and a claim with no worker is already a decision the
      // operator is being asked about.
      //
      // An orphan's task is deleted, so it is in none of the lists above, yet
      // its terminal may still stand in the worktree. The sweep now removes
      // that worktree, so the orphan's branch is kept for the operator to close.
      const accounted = new Set([...claimed, ...reviewing, ...queue].map((task) => task.id));
      const orphaned = new Set(orphans.map((worker) => worker.task));
      const prunable = branches.filter(
        (entry) =>
          entry.merged &&
          !accounted.has(entry.task) &&
          !ownedByTask.has(entry.task) &&
          !orphaned.has(entry.task),
      );

      // Which rungs have no allowance left. A spent account changes which rung
      // a task gets, and at the top of the ladder whether it can be dispatched
      // at all.
      const walled = walledRungs(providers);

      // Work waiting on the operator is ready by every measure prog knows and
      // still must not be dispatched: it is waiting on a decision no agent can
      // make. Split here rather than in fill, so a reader can say where it
      // went instead of leaving it to look like a queue that stopped moving.
      // A task waiting on an allowance stays in the queue, and `outOfQuota`
      // holds it back from a dispatch.
      const failedIds = new Set(failed.map(([task]) => task));
      const { queue: ordered, yours } = queueFrom({
        ready: queue,
        ladder: settings.ladder,
        projects: [...open],
        epics,
        failed: failedIds,
        now: new Date(),
      });

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

      // Where each task stands in its project's pipeline. A task in a stopped
      // project is placed nowhere, and takes no step.
      const placementOf = (task: Item): Placement => {
        const pipeline = runningPipeline(pipelines, task.project);
        return pipeline === undefined
          ? { _tag: "Outside" }
          : place(pipeline, factsOf(task, pipeline));
      };
      const placed = [...ordered, ...yours, ...claimed, ...reviewing].map((task) => ({
        task,
        placement: placementOf(task),
      }));

      // A task waiting at an agent block runs on the rung that block takes.
      // The dispatch resolves the rung the same way from the same reading, so
      // the plan cannot pass over a task the dispatch would have found an
      // agent for, nor the reverse. A rung on a spent account holds the task
      // back; a block with no rung left for it parks it.
      const reviews = reviewable(reviewingActive, committed);
      const candidates: ReadonlyArray<Active> = [
        ...reviews.review,
        ...ordered.map((task) => ({ task, worker: undefined, kind: undefined })),
      ];
      const rungs = candidates.flatMap(({ task, worker }) => {
        const placement = placementOf(task);
        return placement._tag === "At" &&
          placement.state === "waiting" &&
          placement.node.kind === "agent"
          ? [{ task, worker, rung: rungAt(settings.ladder, placement.node, task, walled) }]
          : [];
      });
      const outOfQuota = new Set(
        rungs.filter(({ rung }) => rung._tag === "Waiting").map(({ task }) => task.id),
      );
      const parks: ReadonlyArray<Park> = [
        ...candidates.flatMap(({ task, worker }) => {
          const placement = placementOf(task);
          return placement._tag === "Parked"
            ? [{ task, worker, why: `${task.project}'s pipeline parks it at ${placement.node}.` }]
            : [];
        }),
        ...rungs.flatMap(({ task, worker, rung }) =>
          rung._tag === "Exhausted"
            ? [
                {
                  task,
                  worker,
                  why: "the block it waits at has no rung left that has not failed it.",
                },
              ]
            : [],
        ),
      ].filter(
        // A park is a step: a paused project takes none, and a live pane is
        // still finishing its turn.
        ({ task, worker }) =>
          !held.some((entry) => entry.project === task.project) &&
          (worker === undefined || !isBusy(worker)),
      );
      const parked = new Set(parks.map(({ task }) => task.id));

      // Planned here, from the reading the gates read, so the asks a reading
      // shows and the dispatches fill makes are the same plan by construction.
      const plan = planFrom(
        {
          workers,
          outOfQuota,
          queue: ordered.filter((task) => !parked.has(task.id)),
          held,
          review: reviews.review.filter(({ task }) => !parked.has(task.id)),
          policy,
          scopes,
          pipelines,
          placed,
          dirty,
        },
        failedIds,
        new Set(stale.map((row) => row.task.id)),
      );

      return {
        projects,
        workers,
        owned,
        held,
        orphans,
        providers,
        outOfQuota,
        queue: ordered,
        yours,
        working: claimedActive.filter(isFleetWork),
        ...reviews,
        dispatches: plan.dispatches,
        lands: plan.lands,
        checks: plan.checks,
        parks,
        asks: plan.asks,
        pipelines,
        placed,
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
        policy,
        policyError,
        scopes,
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
     * from — which cost a store read per branch and a `git status` per
     * worktree, and are why the tick's second reading calls `dispatchFrom`
     * directly instead of coming back through here.
     */
    const interpret = (observation: Observation, providers: ReadonlyArray<Provider>) =>
      Effect.gen(function* () {
        const failed = failedTasks(yield* Ref.get(dispatchFailures));
        const current = dispatchFrom(observation, providers, failed);
        const { claimed, reviewing, queue, branches, projects } = observation;
        const { committed } = current;
        const ownedByTask = new Set(current.owned.map((entry) => entry.task.id));

        // Everything below is read for a person to look at rather than for a
        // dispatch to turn on, which is why it is here and not in `dispatchFrom`:
        // the tick's second reading skips all of it.
        const landed = yield* eachProject(projects, (project) => prog.landed(project.name));

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
        const holdingWork = yield* Effect.forEach(workCandidates.values(), (task) =>
          repository.holdsWork(directoryFor(task.project, task.id), labelFor(task.id)).pipe(
            Effect.map((holdsWork) => (holdsWork ? [task.id] : [])),
            Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
          ),
        ).pipe(Effect.map((ids) => ids.flat()));
        const resumable = new Set([...committed, ...holdingWork]);

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
              activity: item.lastActivityAt as Date | undefined,
            })),
            Effect.orElseSucceed(() => ({
              title: undefined,
              status: undefined,
              activity: undefined,
            })),
            Effect.map((item) => ({
              project,
              branch,
              task,
              merged,
              ...item,
            })),
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
          observedAt: now,
        } satisfies Interpretation;
      });

    /** The run row for an agent about to start on this task at `block`. */
    const runFor = (task: Item, rung: Rung, block: AgentNode, commit?: string, base?: string) =>
      newRunFor({
        task,
        branch: labelFor(task.id),
        harness: rung.harness,
        model: rung.model,
        rung: rung.name,
        provider: providerOf(rung),
        role: block.role,
        node: block.id,
        commit,
        base,
      });

    /**
     * The account a stopped author ran on, when its screen ends on that account's
     * usage wall. The screen is the only place a harness shows it. A screen that
     * cannot be read is no wall, so the ordinary retry path runs.
     */
    const onUsageWall = (
      worker: Worker,
      rung: Rung,
      role: AgentRole,
    ): Effect.Effect<Option.Option<UsageWall>> => {
      const provider = providerOf(rung);
      if (provider === undefined) return Effect.succeed(Option.none());
      return fleet.screen(worker, role, WALL_READ_LINES).pipe(
        Effect.map((screen) =>
          Option.flatMap(screen, (text) => hitWall(rung.harness, text)).pipe(
            Option.map((wallText) => ({ provider, text: wallText })),
          ),
        ),
        Effect.catch((error) =>
          Effect.logWarning(
            `reading ${worker.task}'s screen for a usage wall failed: ${error}`,
          ).pipe(Effect.as(Option.none<UsageWall>())),
        ),
      );
    };

    /**
     * Hands a task off after its author stopped on an account's usage wall.
     *
     * The stop is not an attempt and not a failure: nothing was learned about
     * the model, so no count moves and no rung is marked failed. The work is
     * committed so the next author starts from it, and the account is written
     * on the task so its next dispatch skips every rung on it. The agents end,
     * but the worktree stays: teardown would remove it.
     *
     * The commit comes first, so a failed commit leaves the task as it was. The
     * label comes before the release, so a release that fails leaves the task
     * claimed rather than back in the queue on the walled account.
     */
    const handOffWall = (
      task: Item,
      worker: Worker,
      wall: UsageWall,
      walled: ReadonlySet<string>,
    ) =>
      Effect.gen(function* () {
        const committed =
          !isOnboarding(task) && (yield* repository.holdsWork(worker.directory, labelFor(task.id)));
        if (committed) {
          yield* repository.commitWork(
            worker.directory,
            labelFor(task.id),
            `chore(foreman): WIP from ${task.id}: its agent stopped on a usage limit before verifying it`,
          );
        }
        yield* prog.markWall(task.id, wall.provider);
        yield* prog.release(task.id, "walled");
        yield* stopAgents(worker);

        const labels = [...task.labels, `walled:${wall.provider}`];
        const next = authorFor(
          settings.ladder,
          failuresOf({ labels }),
          authorWalls(settings.ladder, { labels }, walled),
        );
        const takeover =
          next._tag === "Dispatch"
            ? `the next author is ${next.rung.name}`
            : next._tag === "Waiting"
              ? `no rung off ${wall.provider} has room, so the task waits in the queue`
              : `every rung off ${wall.provider} has already failed it, so it is the operator's`;
        yield* prog.log(
          task.id,
          `foreman: the author stopped on ${wall.provider}'s usage wall ("${wall.text}"), which is not a failure of its rung. ${committed ? `Its uncommitted work is committed on ${labelFor(task.id)}.` : "It held no uncommitted work."} ${task.id} will not dispatch onto ${wall.provider} again: ${takeover}.`,
        );
      });

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
      const walledNow = walledRungs(current.providers);

      // A stopped project's tasks stay as they are: its pipeline cannot say
      // which block they stand at, so no ending of theirs can be classified.
      const pipelineOf = (task: Item) => runningPipeline(current.pipelines, task.project);

      // Landing writes to the operator's checkout, so it waits for the policy
      // like every step that spends: an approved branch stays approved. The
      // plan holds only the landings the policy permits.
      yield* Effect.forEach(
        current.lands,
        ({ task, worker, permits, block }) =>
          land(task, worker, block).pipe(Effect.tap(() => admitted(permits, task.id))),
        { discard: true },
      );

      // One at a time, after the landings: a check and a landing share the
      // project's proving ground.
      yield* Effect.forEach(
        current.checks,
        ({ task, permits, block }) =>
          runCheck(task, block).pipe(Effect.tap(() => admitted(permits, task.id))),
        { discard: true },
      );

      // An author that handed back an empty branch did not finish, whatever
      // it said by moving the task. Sending a reviewer costs a second agent
      // to read an empty diff. So the task goes back to the queue, which is
      // where unfinished work belongs.
      yield* Effect.forEach(
        current.unbacked.filter(({ task }) => pipelineOf(task) !== undefined),
        ({ task, kind }) =>
          Effect.gen(function* () {
            yield* retryAttempt(
              task,
              `foreman: ${kind ?? "the author"} handed ${task.id} back for review with nothing committed on ${labelFor(task.id)} — there is no work to review.`,
              "stopped",
            );
            yield* teardown(task);
          }),
        { discard: true },
      );

      // An agent that named its exit has finished its block, but its run stays
      // open while its pane finishes the turn, and the task stands at the block,
      // ended. Once the pane is idle its run closes with the exit it named (an
      // author handoff with no exit closes `done` at the tip), and the next tick
      // places the task where the exit leads.
      yield* Effect.forEach(
        current.review.filter(({ task, worker }) => {
          const pipeline = pipelineOf(task);
          return (
            pipeline !== undefined &&
            (worker === undefined || !isBusy(worker)) &&
            endedAt(pipeline, task)
          );
        }),
        ({ task }) =>
          prog
            .endRuns(task.id, { author: "done", review: "stopped", commit: task.tip })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(`closing the handoff of ${task.id} failed: ${error}`),
              ),
            ),
        { discard: true },
      );

      yield* Effect.forEach(
        current.owned.filter(
          ({ task, worker }) =>
            pipelineOf(task) !== undefined &&
            diagnosticIntent(task) !== undefined &&
            worker.state !== "working" &&
            worker.state !== "blocked",
        ),
        ({ task, worker }) =>
          Effect.gen(function* () {
            yield* prog.release(task.id);
            yield* fleet.stop(worker, "author");
            yield* prog.clearDiagnostic(task.id);
            yield* handAuthor(yield* prog.show(task.id));
            yield* Effect.logInfo(`resumed ${task.id} after diagnostic intervention`);
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning(`resuming ${task.id} after diagnosis failed: ${error}`),
            ),
          ),
        { discard: true },
      );

      yield* Effect.forEach(
        current.owned.filter(({ task, worker }) => {
          const pipeline = pipelineOf(task);
          return (
            pipeline !== undefined &&
            diagnosticIntent(task) === undefined &&
            !awaitingLanding(pipeline, task) &&
            // An agent that named its exit finished; the step above closes its run.
            !endedAt(pipeline, task) &&
            worker.state !== "working"
          );
        }),
        ({ task, worker, kind }) =>
          Effect.gen(function* () {
            const reviewer = reviewedBy(task);
            const holdsWork =
              worker.state === "gone" && !isOnboarding(task)
                ? yield* repository.holdsWork(worker.directory, labelFor(task.id))
                : false;
            const phase = phaseOf({
              status: task.status,
              reviewer,
              worker: worker.state,
              attached: isOnboarding(task),
              committed: current.committed.has(task.id),
              holdsWork,
              handoffExpired: handoffExpired(task, coachCutoff),
            });

            // The rung that actually ran, which is what an outcome is about —
            // the reviewer where one owns the pane, else the author.
            const ran = reviewedBy(task) ?? authoredBy(task);
            const rung = settings.ladder.find((candidate) => candidate.name === ran);
            const role = reviewedBy(task) ? "review" : "author";
            // Only a stop without a verdict can be a wall: an onboarding worker
            // stands in the operator's own tree, which foreman never commits, so
            // it is left to the ordinary path.
            const stoppedAuthor =
              role === "author" && (phase === "AuthorStopped" || phase === "VanishedWithWork");
            const stoppedReviewer = role === "review" && phase === "ReviewStopped";
            const wall =
              rung === undefined || isOnboarding(task) || !(stoppedAuthor || stoppedReviewer)
                ? Option.none<UsageWall>()
                : yield* onUsageWall(worker, rung, role);
            if (rung) {
              const attributes = runAttributes(task, rung, role);
              yield* Effect.annotateCurrentSpan({
                ...attributes,
                outcome: phase,
              });
              yield* Metric.update(
                Metric.withAttributes(runOutcomes, {
                  rung: rung.name,
                  project: task.project,
                  outcome: phase,
                }),
                1,
              );
            }

            yield* Match.value(phase).pipe(
              Match.when("Landed", () =>
                prog
                  .endRuns(task.id, { author: "released", review: "released" })
                  .pipe(
                    Effect.andThen(fleet.notify("Task landed", `${task.id} ${task.title}`)),
                    Effect.andThen(teardown(task)),
                  ),
              ),
              Match.when("Canceled", () =>
                prog
                  .endRuns(task.id, { author: "canceled", review: "released" })
                  .pipe(
                    Effect.andThen(fleet.notify("Task canceled", `${task.id} ${task.title}`)),
                    Effect.andThen(teardown(task)),
                  ),
              ),
              Match.when("ReviewReturned", () =>
                prog
                  .endReview(task.id, "released")
                  .pipe(
                    Effect.andThen(
                      prog.log(
                        task.id,
                        `foreman: reviewer ${reviewer} sent ${task.id} back with findings. Returned to the queue — read the review notes above and continue from ${labelFor(task.id)}.`,
                      ),
                    ),
                    Effect.andThen(
                      charge(task, openExitOf(pipelineOf(task), task)?.fails, reviewer),
                    ),
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
                Option.match(wall, {
                  onNone: () =>
                    retryAttempt(
                      task,
                      `foreman: ${kind ?? "the author"} vanished mid-task and left unfinished work in ${worker.directory}. Read git status and git log ${labelFor(task.id)} before you plan anything, and continue from what is there.`,
                      "vanished",
                    ),
                  onSome: (hit) => handOffWall(task, worker, hit, walledNow),
                }),
              ),
              Match.when("VanishedEmpty", () =>
                retryAttempt(
                  task,
                  `foreman: ${kind ?? "the author"} vanished without writing anything — no commits on ${labelFor(task.id)} and an untouched worktree.`,
                  "vanished",
                ).pipe(Effect.andThen(teardown(task))),
              ),
              Match.when("Blocked", () => Effect.void),
              Match.when("ReviewWaiting", () => Effect.void),
              Match.when("ReviewExpired", () => stopAgents(worker)),
              Match.when("ReviewStopped", () =>
                Option.match(wall, {
                  onNone: () =>
                    stoppedAt(pipelineOf(task), task) === "park"
                      ? parkStopped(
                          task,
                          worker,
                          `reviewer ${reviewer} stopped without naming an exit`,
                        )
                      : reviewerStopped(task, worker, reviewer),
                  onSome: (hit) =>
                    prog
                      .endReview(task.id, "walled")
                      .pipe(
                        Effect.andThen(prog.markWall(task.id, hit.provider)),
                        Effect.andThen(stopAgents(worker)),
                        Effect.andThen(
                          prog.log(
                            task.id,
                            `foreman: reviewer ${reviewer} stopped on ${hit.provider}'s usage wall ("${hit.text}"), which is not a failure of its rung. ${task.id} stays in review and will not be read on ${hit.provider} again.`,
                          ),
                        ),
                      ),
                }),
              ),
              Match.when("Residue", () =>
                prog.endRuns(task.id, { author: "released", review: "released" }).pipe(
                  Effect.andThen(
                    Effect.forEach([...worker.roles.keys()], (role) => fleet.stop(worker, role), {
                      discard: true,
                    }),
                  ),
                ),
              ),
              Match.when("AuthorStopped", () =>
                Option.match(wall, {
                  onNone: () =>
                    stoppedAt(pipelineOf(task), task) === "park"
                      ? parkStopped(
                          task,
                          worker,
                          `${kind ?? "agent"} stopped without naming an exit`,
                        )
                      : retryAttempt(
                          task,
                          `foreman: ${kind ?? "agent"} stopped without finishing (status ${task.status}).`,
                          "stopped",
                        ).pipe(
                          Effect.andThen(teardown(task)),
                          Effect.andThen(
                            fleet.notify(
                              "Task returned",
                              `${task.id} stopped with no exit — back in the queue`,
                            ),
                          ),
                        ),
                  onSome: (hit) => handOffWall(task, worker, hit, walledNow),
                }),
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
     * The only code path that moves the operator's branch. No agent holds merge rights, reviewer
     * or author, so every branch passes the same clean-checkout and verification
     * gate.
     */
    const land = Effect.fn("foreman.land")(function* (
      task: Item,
      worker: Worker | undefined,
      block: LandNode | DoneNode,
    ) {
      yield* Effect.gen(function* () {
        const project = yield* projectFor(task.project);
        if (!project) return;

        // A done block ends a route with no branch: the author committed onto
        // the operator's branch, and the reviewer approved what it read there.
        // Nothing is left to merge or prove, but the approval holds only while
        // the checkout is still at the commit the reviewer read: a later commit
        // voids it, and the next review reads the new one.
        if (block.kind === "done") {
          const approved = routedCommit(task);
          const head = yield* repository.head(project.directory);
          if (approved === undefined || head !== approved) {
            return yield* Effect.logWarning(
              `completing ${task.id} (${project.name}) refused: the checkout moved after its approval`,
            );
          }
          yield* prog.log(
            task.id,
            `foreman: completed at ${block.id}. The work was committed onto ${project.name}'s branch, so nothing was merged.`,
          );
          yield* Effect.logInfo(`completed ${task.id} (${project.name}) at ${block.id}`);
          yield* prog.complete(task);
          yield* fleet.notify("Task done", `${task.id} ${task.title}`);
          return yield* teardown(task);
        }

        // The commit the reviewer read is the commit that lands. A tip that moved
        // since the approval voids it, and the next review reads the new one.
        const approved = routedCommit(task);
        const tip = yield* repository.tip(project.directory, labelFor(task.id));
        if (approved === undefined || tip !== approved) {
          return yield* Effect.logWarning(
            `landing ${task.id} (${project.name}) refused: ${labelFor(task.id)} moved after its approval`,
          );
        }

        const result = yield* repository.merge(
          project.directory,
          labelFor(task.id),
          approved,
          project.verify,
          verifyDirectoryFor(project.name),
          `Merge ${labelFor(task.id)}: ${task.title}`,
          block.how ?? "merge",
        );
        // The approval is a run that names the commit it read, so a later tick
        // lands from it with no pane at all — and a project can stay dirty for hours.
        if (result._tag === "Held") {
          // An operator editing, or another task's branch out in the checkout,
          // clears itself and is not worth a line every poll. Any other hold — a missing landing target, a machine foreman
          // could not run — never clears and must not retry in silence.
          if (result.reason !== "dirty" && result.reason !== "busy" && result.detail) {
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
        // ends stopped, and `retryAttempt` is what bounds that.
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
        // whose author named `already-done` and whose
        // reviewer confirmed it. The verdict cannot tell them apart — an empty
        // branch is contained by any checkout — so the label the author left
        // is what names the one in the log.
        if (result._tag === "Present") {
          yield* Effect.logInfo(
            `${task.id} (${project.name}) was already in the checkout; completing`,
          );
          yield* prog.log(
            task.id,
            claimsAlreadyDone(task)
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

        yield* prog.complete(task);
        yield* fleet.notify("Task landed", `${task.id} ${task.title}`);
        yield* teardown(task);
      }).pipe(Effect.catch((error) => Effect.logWarning(`landing ${task.id} failed: ${error}`)));
    });

    /**
     * Runs a check block's command on the task's branch tip, in the project's
     * proving ground, and records the run against that commit.
     *
     * A pass advances the task past the block for as long as the tip stays
     * there. A failure returns it to the queue a rung up with the output in its
     * log, as broken verification does at a landing: the next author's job is
     * the failure. A ground that is not ready says nothing about the branch, and
     * neither does a tip that moved while the command ran, so neither records
     * a run, and a later reading checks again.
     */
    const runCheck = Effect.fn("foreman.check")(function* (task: Item, block: CheckNode) {
      yield* Effect.gen(function* () {
        const project = yield* projectFor(task.project);
        if (!project) return;
        const tip = yield* tipOf(task, project);
        if (tip === undefined) {
          return yield* Effect.logWarning(
            `checking ${task.id} at ${block.id}: ${labelFor(task.id)} is gone`,
          );
        }
        const base = yield* baseOf(task, project);
        if (base === undefined) {
          return yield* Effect.logWarning(
            `checking ${task.id} at ${block.id}: no commit its work started from`,
          );
        }

        const result = yield* repository.check(
          project.directory,
          tip,
          base,
          block.command,
          verifyDirectoryFor(project.name),
        );
        if (result._tag === "Held") {
          return yield* Effect.logWarning(
            `checking ${task.id} at ${block.id} held: ${result.detail}`,
          );
        }
        if ((yield* tipOf(task, project)) !== tip) {
          return yield* Effect.logWarning(
            `checking ${task.id} at ${block.id}: its work moved while ${block.command} ran`,
          );
        }

        const passed = result._tag === "Passed";
        yield* prog.recordCheck({
          project: task.project,
          task: task.id,
          node: block.id,
          command: block.command,
          commit: tip,
          ending: passed ? "passed" : "failed",
        });
        if (passed) {
          if (!result.verified) {
            yield* prog.log(
              task.id,
              `foreman: \`${block.command}\` fails at the commit its work started from as well, so it says nothing about this work, and the check ${block.id} passes it.`,
            );
          }
          return;
        }

        // The failed exit charges what the drawing says, and a return sends the
        // task to the queue; a wire elsewhere moves it with no write at all.
        const exit = block.exits.find((candidate) => candidate.name === "failed");
        const returns = exit?.to === QUEUE;
        yield* Effect.logWarning(`${task.id} failed the check ${block.id}`);
        yield* prog.log(
          task.id,
          `foreman: the check ${block.id} ran \`${block.command}\` at ${tip}, and it failed${returns ? ", so the task is back in the queue" : ""}.\n\n${result.output}`,
        );
        yield* charge(task, exit?.fails, undefined);
        if (returns) {
          yield* prog.release(task.id);
          yield* fleet.notify("Check failed", `${task.id} failed ${block.id} — back in the queue`);
        }
      }).pipe(Effect.catch((error) => Effect.logWarning(`checking ${task.id} failed: ${error}`)));
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
     * Only a claim foreman's own agent made, which its author run records,
     * and only once no agent of the task is live and it has gone stale. A
     * claim made by hand or by another session is that person's to give up:
     * foreman cannot tell an abandoned one from one whose owner is away.
     */
    const reclaim = (current: Interpretation) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const cutoff = DateTime.subtract(now, { hours: settings.staleAfter });

        yield* Effect.forEach(
          [
            ...current.working.filter(({ task }) => authoredBy(task) !== undefined),
            ...current.review.filter(({ task }) => reviewedBy(task) !== undefined),
          ].filter(
            ({ task, worker }) =>
              (worker === undefined || worker.state === "gone") &&
              DateTime.isLessThan(DateTime.fromDateUnsafe(task.lastActivityAt), cutoff),
          ),
          ({ task, worker }) =>
            Effect.gen(function* () {
              yield* prog.log(
                task.id,
                `foreman: claim released — no activity since ${task.lastActivityAt.toISOString()}.`,
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
    const fill = (current: Dispatchable) =>
      Effect.gen(function* () {
        yield* Effect.forEach(current.parks, park, { discard: true });
        // A task whose dispatch has failed twice is held out of the plan.
        // Its failure is a fact about the world, so a third attempt would
        // repeat the second; the operator clears the cause and retries.
        // This tick's burst, not a memory: one set per fill pass, read by the
        // authors only, and discarded with it. Its whole job is to stop every
        // slot in this pass drawing on the one account the reading calls healthy.
        const drawn = new Set<string>();
        yield* Effect.forEach(
          current.dispatches,
          (dispatch) =>
            (dispatch.role === "review"
              ? dispatchReview(dispatch.task, dispatch.block)
              : dispatchAuthor(dispatch.task, dispatch.block, drawn)
            ).pipe(
              Effect.tap(() => admitted(dispatch.permits, dispatch.task.id)),
              Effect.tap(() => clearFailure(dispatch.task.id)),
              Effect.catch((error) => recordFailure(dispatch.task.id, error)),
            ),
          { discard: true },
        );
      });

    /**
     * Hands a task to the operator: its route ends at a park block, or the
     * block it waits at has no rung left for it.
     *
     * The task is released first, so it leaves the pipeline for the operator's
     * column, and the next reading does not park it again.
     */
    const park = ({ task, why }: Park) =>
      Effect.gen(function* () {
        if (task.status !== "open") yield* prog.release(task.id);
        yield* prog.parkForOperator(task.id);
        yield* prog.log(task.id, `foreman: ${task.id} is yours now: ${why}`);
        yield* fleet.notify("Needs a decision", `${task.id} ${task.title}: ${why}`);
      }).pipe(Effect.catch((error) => Effect.logWarning(`parking ${task.id} failed: ${error}`)));

    /** The workspace the task's route gives it, from the published reading. */
    const routeOf = (task: Item) =>
      SubscriptionRef.get(state).pipe(Effect.map(({ pipelines }) => workspaceOf(pipelines, task)));

    /**
     * The commit the task's work stands at now: its branch's tip, or the
     * checkout's HEAD for a task on the operator's own branch.
     */
    const tipOf = (task: Item, project: Project) =>
      Effect.gen(function* () {
        return (yield* routeOf(task)) === "none"
          ? yield* repository.head(project.directory)
          : yield* repository.tip(project.directory, labelFor(task.id));
      });

    /**
     * The commit the task's work started from: its branch's fork point, or
     * the first direct author's base, since direct work has no undo.
     */
    const baseOf = (task: Item, project: Project) =>
      Effect.gen(function* () {
        return (yield* routeOf(task)) === "none"
          ? directBase(task)
          : yield* repository.base(project.directory, labelFor(task.id));
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
    const workspaceFor = (task: Item, project: Project) =>
      Effect.gen(function* () {
        // The task's route chooses where a new workspace goes. One that
        // exists is adopted wherever git has the branch out.
        const directory = newWorkspace(yield* routeOf(task), project, task.id);
        const worker =
          directory === undefined
            ? yield* fleet.attach({ task: task.id, repository: project.directory })
            : yield* fleet.open({
                task: task.id,
                repository: project.directory,
                branch: labelFor(task.id),
                directory,
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
     * The rung `block` runs this task on now, or nothing when none can.
     *
     * It reads the same tick's allowances as the plan, for the same reason:
     * every dispatch and the plan that offered the task must agree, or the plan
     * passes over work a dispatch would have found an agent for. `undefined` is
     * not an error. The task keeps its place and a later tick, or an allowance
     * reset, asks again. The reading is the tick's own: `state` is published
     * before any pass runs, and for an operator's command it is the reading the
     * dashboard was showing when they pressed the key.
     */
    const rungFor = Effect.fnUntraced(function* (
      task: Item,
      block: AgentNode,
      drawn?: Set<string>,
    ) {
      const walled = walledRungs((yield* SubscriptionRef.get(state)).providers);
      const choice = rungAt(settings.ladder, block, task, walled, drawn);
      if (choice._tag === "Dispatch") {
        const provider = providerOf(choice.rung);
        if (provider !== undefined) drawn?.add(provider);
        return choice.rung;
      }
      yield* Effect.logInfo(
        choice._tag === "Waiting"
          ? `${block.role} of ${task.id} at ${block.id} deferred: no account with room for ${block.model}`
          : `${block.role} of ${task.id} at ${block.id} deferred: no rung of ${block.model} is left that has not failed it`,
      );
      return undefined;
    });

    /**
     * The agent block an agent started by hand runs at: the first block of
     * `role` on the task's route that it has not passed. Nothing when the
     * project's pipeline is stopped or the route has no such block, and the
     * dispatch is then refused: its run would record a block the task never
     * stood at.
     */
    const blockFor = Effect.fnUntraced(function* (task: Item, role: AgentRole) {
      const pipeline = runningPipeline((yield* SubscriptionRef.get(state)).pipelines, task.project);
      const block =
        pipeline === undefined ? undefined : nextAgent(pipeline, factsOf(task, pipeline), role);
      if (block === undefined) {
        yield* Effect.logWarning(
          `${role} of ${task.id} refused: ${task.project}'s pipeline has no ${role} block on its route`,
        );
      }
      return block;
    });

    /** Starts an author by hand, at the author block on the task's route. */
    const handAuthor = (task: Item) =>
      blockFor(task, "author").pipe(
        Effect.flatMap((block) =>
          block === undefined ? Effect.void : dispatchAuthor(task, block),
        ),
      );

    /** Starts a reviewer by hand, at the review block on the task's route. */
    const handReview = (task: Item) =>
      blockFor(task, "review").pipe(
        Effect.flatMap((block) =>
          block === undefined ? Effect.void : dispatchReview(task, block),
        ),
      );

    const dispatchAuthor = Effect.fn("foreman.dispatch.author")(function* (
      task: Item,
      block: AgentNode,
      drawn?: Set<string>,
    ) {
      // The task carries its failures in its labels, so the choice survives a
      // restart, and the allowances are this tick's reading. `drawn` is this
      // tick's burst, not the task's history: only `fill` has one, so only it
      // spreads.
      const rung = yield* rungFor(task, block, drawn);
      if (rung) yield* authorAt(task, rung, block);
    });

    /** Opens the task's workspace, claims it and starts its author on this rung. */
    const authorAt = Effect.fn("foreman.dispatch.authorAt")(function* (
      task: Item,
      rung: Rung,
      block: AgentNode,
    ) {
      const project = yield* projectFor(task.project);
      if (!project) return;

      // The workspace opens before the claim. If it opened after, a task
      // would briefly be claimed with nothing to show for it, and that state
      // is indistinguishable from an abandoned claim.
      const worker = yield* workspaceFor(task, project);
      const workspace = yield* routeOf(task);
      // A task on the operator's branch has no branch to diff against, so its
      // author run records where the checkout stood when it started.
      const base = workspace === "none" ? yield* repository.head(project.directory) : undefined;

      const prompt = yield* prompts.author(
        task,
        worker.directory,
        project.directory,
        workspace,
        directBase(task) ?? base,
      );
      yield* prog.claim(task.id);
      yield* prog
        .attribute(task.id, runFor(task, rung, block, undefined, base))
        .pipe(Effect.tapError(() => prog.release(task.id)));
      const agent = yield* instrumentRun(
        task,
        rung,
        "author",
        fleet.spawn(worker, spawnAs(rung, prompt, "author")).pipe(
          // The agent never started, so the claim would strand the task until
          // the stale sweep noticed, and its run never happened. Hand both back
          // immediately instead.
          Effect.tapError(() => prog.abandon(task.id, "author")),
        ),
      );
      yield* prog.log(task.id, agentLog("author", rung, agent));
      yield* Effect.logInfo(
        `dispatched ${task.id} (${task.project}) to ${rung.name} in ${worker.directory}`,
      );
    });

    const dispatchReview = Effect.fn("foreman.dispatch.review")(function* (
      task: Item,
      block: AgentNode,
    ) {
      const project = yield* projectFor(task.project);
      if (!project) return;

      // The fork point is how the reviewer names the author's work from
      // inside its own worktree; without it the only diff it could read is in
      // the operator's checkout. A task on the operator's own branch reads
      // everything since its first author started (it has no undo). The status
      // is untouched, so a later tick tries again.
      const workspace = yield* routeOf(task);
      const base = yield* baseOf(task, project);
      const tip = yield* tipOf(task, project);
      if (!base || tip === undefined) {
        return yield* Effect.logWarning(
          `review of ${task.id} deferred: no base for its work in ${project.directory}`,
        );
      }

      // Resolved here rather than by each caller, so fill, a retry and an
      // intervention all pick a reviewer the same way. The status is untouched
      // when no rung can read the diff, so the task keeps its place.
      const rung = yield* rungFor(task, block);
      if (!rung) return;
      const worker = yield* workspaceFor(task, project);

      const prompt = yield* prompts.review(
        task,
        worker.directory,
        project.directory,
        workspace,
        base,
        project.verify,
      );
      // The run records the tip the reviewer is about to read: its approval
      // is about this commit until the reviewer names its exit, which records
      // the tip it names it on.
      yield* prog.assignReview(task.id, runFor(task, rung, block, tip));
      const agent = yield* instrumentRun(
        task,
        rung,
        "review",
        fleet
          .spawn(worker, spawnAs(rung, prompt, "review"))
          .pipe(Effect.tapError(() => prog.abandon(task.id, "review"))),
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
          `Foreman found uncommitted changes in ${project.directory}. This task is the salvage run: preserve the work on a rescue branch, report what it was doing and what passes, and leave the checkout clean.`,
          [ONBOARD],
        );

        yield* dispatchOnboard(yield* prog.show(id), project);
      });

    const dispatchOnboard = Effect.fn("foreman.dispatch.onboard")(function* (
      task: Item,
      project: Project,
    ) {
      const rung = topOf(settings.ladder);
      const block = yield* blockFor(task, "author");
      if (block === undefined) return;

      // Attached, not a worktree: the work being rescued exists only in this
      // checkout, so a copy of the last commit would show the agent nothing.
      const worker = yield* fleet.attach({
        task: task.id,
        repository: project.directory,
      });
      const prompt = yield* prompts.onboard(task, project.directory);
      // On a direct route the reviewer reads from where the checkout stood, as
      // for any direct author.
      const base =
        (yield* routeOf(task)) === "none" ? yield* repository.head(project.directory) : undefined;

      yield* prog.claim(task.id);
      yield* prog
        .attribute(task.id, runFor(task, rung, block, undefined, base))
        .pipe(Effect.tapError(() => prog.release(task.id)));
      const agent = yield* instrumentRun(
        task,
        rung,
        "author",
        fleet
          .spawn(worker, spawnAs(rung, prompt, "author"))
          .pipe(Effect.tapError(() => prog.abandon(task.id, "author"))),
      );
      yield* prog.log(task.id, agentLog("author", rung, agent));
      yield* Effect.logInfo(`onboarding ${project.name} as ${task.id} with ${rung.name}`);
    });

    /**
     * Routes an agent that stopped without finishing, which has said nothing
     * about its rung.
     *
     * A crash and a timeout end identically, so the task stays on the rung and
     * is tried again, up to `attemptsPerRung`; a usage wall is not routed here
     * at all (see `handOffWall`). The
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
    const retryAttempt = (task: Climbing, detail: string, ending: Ending) =>
      Effect.gen(function* () {
        yield* prog.release(task.id, ending);
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
     * Parks a task whose agent stopped without naming an exit at a block that
     * says `stopped: park`: its runs close `stopped`, it leaves the queue for
     * the operator, and no rung is charged.
     */
    const parkStopped = (task: Item, worker: Worker, what: string) =>
      Effect.gen(function* () {
        yield* prog.endRuns(task.id, { author: "stopped", review: "stopped" });
        yield* prog.release(task.id);
        yield* prog.parkForOperator(task.id);
        yield* prog.log(
          task.id,
          `foreman: ${what}, and its block parks such a task. It is yours now.`,
        );
        yield* fleet.notify("Needs a decision", `${task.id} ${task.title}: ${what}`);
        yield* stopAgents(worker);
      });

    /**
     * Hands a task to the next reviewer after one stopped without a verdict.
     *
     * The task stays in `reviewing` and the author is not charged: the stop says
     * nothing about the author's work. The reviewer's rung is recorded so the
     * next one is chosen above it. With no rung left the review cannot proceed,
     * and a person decides: the task is released and parked, which also clears
     * the recorded reviewers for whatever comes next.
     */
    const reviewerStopped = (task: Item, worker: Worker, reviewer: string | undefined) =>
      Effect.gen(function* () {
        const ran = reviewer ?? "the reviewer";
        // A reviewer that gave a verdict has not failed, even when a later commit
        // voided it: the next review reads the new tip, and that rung may read it.
        const said = lapOf(task).some(
          (run) => run.role === "review" && run.open && run.ending !== undefined,
        );
        const failed = [
          ...reviewFailedBy(task),
          ...(reviewer === undefined || said ? [] : [reviewer]),
        ];
        const next = reviewerFor(settings.ladder, authoredBy(task), new Set(), failed);
        if (next === undefined) {
          yield* prog.endReview(task.id, "stopped");
          yield* prog.release(task.id);
          yield* prog.parkForOperator(task.id);
          yield* prog.log(
            task.id,
            `foreman: reviewer ${ran} stopped without a verdict, and no rung above it is left to read ${task.id}. It is yours now.`,
          );
          yield* fleet.notify("Needs a decision", `${task.id} ${task.title}: no reviewer left`);
        } else {
          yield* prog.endReview(task.id, "stopped");
          yield* prog.log(
            task.id,
            `foreman: reviewer ${ran} ${said ? "approved a commit the branch has moved past" : "stopped without a verdict"}. ${task.id} stays in review; the next reviewer is ${next.name}.`,
          );
        }
        yield* stopAgents(worker);
      });

    /**
     * The rung whose run has just ended, which is the one a verdict is about.
     *
     * Read from the task rather than recomputed: the author run says which model
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
    /**
     * Charges the rung a named exit's `fails` names: `author` the task's last
     * author run's rung, exactly as `climb` does; `self` the rung of the block
     * that named it, `rung`. An exit with no `fails`, or a `self` with no rung
     * (a check), charges nothing.
     */
    const charge = (task: Climbing, fails: Exit["fails"], rung: string | undefined) =>
      fails === "author"
        ? climb(task)
        : fails === "self" && rung !== undefined
          ? prog.markFailure(task.id, rung)
          : Effect.void;

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

    /**
     * The project set for one reading: the checkouts open spaces sit in, and
     * the checkouts foreman's agents still run in (`src/projects.ts`).
     */
    const resolveProjects = (everyone: ReadonlyArray<Worker>) =>
      Effect.gen(function* () {
        const open = yield* openCheckouts(fleet, repository);
        const running = everyone.flatMap((worker) =>
          worker.repository === undefined ? [] : [worker.repository],
        );
        const { projects, ambiguous } = projectSet(open, running);
        const verified = yield* Effect.forEach(projects, (project) =>
          repository
            .verifyOf(project.directory)
            .pipe(Effect.map((verify): Project => ({ ...project, verify }))),
        );
        return { projects: verified, ambiguous };
      });

    /** A project of the latest reading, which every command and pass follows. */
    const projectFor = (name: string) =>
      SubscriptionRef.get(state).pipe(
        Effect.map(({ projects }) => projects.find((candidate) => candidate.name === name)),
      );

    const branchCommitted = (task: Item) =>
      Effect.gen(function* () {
        const project = yield* projectFor(task.project);
        if (!project) return false;
        const branches = yield* repository.branches(project.directory);
        return branches.find((branch) => branch.branch === labelFor(task.id))?.empty === false;
      });

    const holdsIntervenableWork = (task: Item, worker: Worker | undefined) =>
      worker
        ? Effect.succeed(true)
        : branchCommitted(task).pipe(
            Effect.flatMap((committed) =>
              committed
                ? Effect.succeed(true)
                : repository
                    .holdsWork(directoryFor(task.project, task.id), labelFor(task.id))
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
        const project = yield* projectFor(task.project);
        const rung = settings.ladder.find((candidate) => candidate.name === rungName);
        if (!project || !rung || !(yield* holdsIntervenableWork(task, target.worker))) return;

        yield* stopAgents(target.worker);
        if (reviewedBy(task) !== undefined) yield* prog.endReview(task.id, "released");
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
        if (reviewedBy(task) !== undefined) yield* prog.endReview(task.id, "released");
        if (task.status === "open") yield* prog.claim(task.id);
        if (task.status !== "reviewing") yield* prog.review(task.id);
        yield* handReview(yield* prog.show(task.id));
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
        if (reviewedBy(task) !== undefined) yield* prog.endReview(task.id, "released");
        yield* prog.clearDiagnostic(task.id);
        if (task.status !== "open") yield* prog.release(task.id);
        yield* raiseFloor(task, rung);
        yield* handAuthor(yield* prog.show(task.id));
      });

    /** The checkout a project's work lands in, when foreman is configured for it. */
    const repositoryFor = (task: { readonly project: string }) =>
      projectFor(task.project).pipe(Effect.map((project) => project?.directory));

    /**
     * Takes down a task's workspace and, with it, the worktree foreman made.
     * `fleet.close` resolves the same way `open` does, so a workspace the fleet has
     * already dropped still leaves its worktree removed rather than orphaned.
     */
    const teardown = (task: { readonly id: string; readonly project: string }) =>
      repositoryFor(task).pipe(
        Effect.flatMap((repository) => fleet.close({ task: task.id, repository })),
      );

    const eachProject = <A>(
      projects: ReadonlyArray<Project>,
      read: (project: Project) => Effect.Effect<ReadonlyArray<A>, Error>,
    ) =>
      Effect.forEach(projects, (project) =>
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

      /** Reads and settles the world once. `run` repeats it. */
      tick,

      /**
       * Tells `run` to tick now instead of at the end of its poll interval. A
       * host calls it after a one-shot command changed the world from another
       * process, so the next reading shows what the command did.
       */
      wake: nudge,

      /** Reads the world once without acting on it. */
      read: Effect.asVoid(read),

      /** Runs until interrupted. */
      run: Effect.gen(function* () {
        yield* Effect.logInfo(
          `foreman up: over the open spaces' projects, polling every ${settings.pollInterval}s, policy in ${policyPath()}`,
        );
        yield* Effect.forkScoped(watchPolicy);
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

      /** Brings a task's workspace to the front so you can take over. */
      focus: (worker: Worker) => fleet.focus(worker),

      /** Stops a live attempt, records why, and returns the task unchanged to the queue. */
      kill: (target: InterventionTarget, reason: Option.Option<string>) =>
        commanded(
          Effect.gen(function* () {
            const task = yield* prog.show(target.task.id);
            if (task.status === "done" || task.status === "canceled" || !target.worker) return;
            yield* stopAgents(target.worker);
            if (task.status !== "open") yield* prog.release(task.id);
            yield* prog.log(task.id, killLogLine(reason));
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
            const found = yield* projectFor(project);
            if (found) yield* onboard(found);
          }),
        ),

      /**
       * Starts a queued task's author now, on the rung the tick would choose or
       * on the one named. A named rung is the operator's choice for this one
       * dispatch and writes no label, so the task's evidence is unchanged.
       */
      author: (task: Item, rungName: string | undefined) =>
        commanded(
          Effect.gen(function* () {
            const block = yield* blockFor(task, "author");
            if (block === undefined) return;
            const rung =
              rungName === undefined
                ? yield* rungFor(task, block)
                : settings.ladder.find((candidate) => candidate.name === rungName);
            if (rung) yield* authorAt(task, rung, block);
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
          const project = yield* projectFor(task.project);
          if (!project) return undefined;
          const { pipelines } = yield* SubscriptionRef.get(state);
          const worktree =
            newWorkspace(workspaceOf(pipelines, task), project, task.id) ?? project.directory;
          if (role === "author") {
            return yield* prompts.author(
              task,
              worktree,
              project.directory,
              workspaceOf(pipelines, task),
              directBase(task),
            );
          }
          const workspace = workspaceOf(pipelines, task);
          const base =
            workspace === "none"
              ? directBase(task)
              : yield* repository.base(project.directory, labelFor(task.id));
          if (!base) return undefined;
          return yield* prompts.review(
            task,
            worktree,
            project.directory,
            workspace,
            base,
            project.verify,
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
                const project = yield* projectFor(task.project);
                if (project) {
                  yield* dispatchOnboard(task, project).pipe(
                    Effect.catch((error) => recordFailure(task.id, error)),
                  );
                }
                return;
              }
              return yield* (
                task.status === "reviewing" ? handReview(task) : handAuthor(task)
              ).pipe(Effect.catch((error) => recordFailure(task.id, error)));
            }

            if (task.status === "reviewing") {
              return yield* handReview(task);
            }

            // A salvage run that stopped is retried as a salvage run. Sending an
            // author into a worktree would show it a copy of the last commit,
            // which is precisely the state that has none of the work in it.
            if (isOnboarding(task)) {
              const project = yield* projectFor(task.project);
              if (project) yield* dispatchOnboard(task, project);
              return;
            }

            const project = yield* projectFor(task.project);
            if (!project) return;
            const block = yield* blockFor(task, "author");
            if (block === undefined) return;
            const rung = yield* rungFor(task, block);
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
              yield* routeOf(task),
              directBase(task),
            );
            const agent = yield* fleet.spawn(worker, spawnAs(rung, prompt, "author"));
            // The vanished author's run is still open; the new author starts a new lap.
            yield* prog.endRuns(task.id, { author: "vanished" });
            yield* prog.attribute(task.id, runFor(task, rung, block));
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
      complete: (task: Item, reason: string) =>
        commanded(
          prog
            .log(task.id, `foreman: marked done from queue: ${reason}`)
            .pipe(Effect.andThen(prog.complete(task))),
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
       * Ends an open review run no reviewer is behind, at the operator's
       * word.
       *
       * The world records whether a reviewer was dispatched, not whether that
       * reviewer is still alive, so only the operator can say the run is
       * stale — the dashboard offers this exactly where the workspace is gone
       * and the task is open. An open review run on an open task is as stale
       * as the reviewer behind it: nothing is awaiting landing, and the task
       * is going to change hands. Liveness is the view's call; the run is
       * re-checked here only so an already-ended snapshot ends nothing.
       *
       * It ends `released`, not `stopped`: a reviewer that vanished says
       * nothing about whether its rung can read the diff, so the rung stays
       * open to review it again.
       */
      unassign: (task: Climbing) =>
        commanded(
          Effect.gen(function* () {
            if (reviewedBy(task) === undefined) return;
            yield* prog.endReview(task.id, "released");
          }),
        ),

      /**
       * Names the exit that ends the task's open agent run (`foreman exit`).
       *
       * The name must be one the block of that run declares; otherwise nothing
       * is written and the answer lists the declared names. The exit records
       * the task's tip as its route reads it (the branch tip, or the checkout's
       * HEAD on a direct route), so a correction round needs no special case:
       * the reviewer names its exit after the round, on the tip the round left. The
       * status move is the one the exit's wire implies: a return to the queue
       * reopens the task, and settle releases it; an author's exit onward sends
       * it to review; a reviewer's exit onward leaves the status as it is.
       */
      exit: (id: string, name: string) =>
        commanded(
          Effect.gen(function* () {
            const task = yield* prog.show(id);
            yield* read;
            const pipeline = runningPipeline(
              (yield* SubscriptionRef.get(state)).pipelines,
              task.project,
            );
            const open = openAgentOf(pipeline, task);
            if (open === undefined) return { _tag: "NoRun" } as const;
            const { block } = open;
            const exit = block.exits.find((candidate) => candidate.name === name);
            if (exit === undefined) {
              return {
                _tag: "Undeclared",
                block: block.id,
                declared: block.exits.map((candidate) => candidate.name),
              } as const;
            }
            const project = yield* projectFor(task.project);
            const commit = project ? yield* tipOf(task, project) : undefined;
            yield* prog.nameExit(task.id, {
              name,
              commit,
              event:
                exit.to === QUEUE
                  ? "open"
                  : block.role === "author" && task.status === "in_progress"
                    ? "review"
                    : undefined,
            });
            return { _tag: "Named", block: block.id, commit } as const;
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
      /**
       * Answers an ask with one grant: the step it holds, on that one task,
       * counted once. The grant is an ordinary one, so the next tick takes the
       * step as it would for any granted task. It keeps covering the task until
       * the task is finished, so a rejected review's rerun is not asked again.
       */
      approve: (ask: Ask) =>
        commanded(
          updatePolicy(policyPath(), (policy) => grant(policy, ask.task.id, [ask.step], 1)).pipe(
            Effect.provideContext(platform),
            Effect.asVoid,
          ),
        ),
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

/**
 * Selects work for the free slots without performing any dispatch side effects.
 *
 * Each task is placed in its project's pipeline. A task waiting at a work block
 * is a candidate when every gate on its route permits it, and candidates are
 * taken nearest the end of the pipeline first (fewest work blocks left), then
 * in the order given: the review column, then the queue. In the standard
 * pipeline that is landings, then reviews, then new work.
 *
 * Each dispatch carries the permits its gates gave it, so the caller can
 * record which grants admitted the task once the dispatch has happened. A task
 * the policy does not allow is passed over and keeps no slot.
 *
 * A task whose gate is set to `ask` is listed in `asks` and takes no slot: a
 * slot is spent when a step runs, not when the operator is asked about it. So
 * review and climb asks are listed whatever the free count, and an ask ahead
 * in the queue never holds back a granted task behind it. Author asks are
 * capped at the policy's `slots`, so an `ask` author step does not list the
 * whole queue. Approving an ask grants the step, and the granted dispatch then
 * waits for a free slot like any other. A landing and a check run no agent, so
 * neither takes a slot.
 *
 * An agent block with `slots` runs at most that many of its tasks at once,
 * inside the fleet's own limit. The tasks running there now are counted from
 * where `placed` stands them, and each dispatch this pass plans there counts
 * too.
 */
export const planFrom = (
  current: DispatchState,
  failed: ReadonlySet<string> = new Set(),
  stale: ReadonlySet<string> = new Set(),
): Plan => {
  const busy = current.workers.filter(isBusy).length;
  let free = current.policy.slots - busy;
  let authorAsks = 0;
  const running = runningAt(current.placed);

  const dispatches: Array<PlannedDispatch> = [];
  const lands: Array<PlannedLanding> = [];
  const checks: Array<PlannedCheck> = [];
  const asks: Array<Ask> = [];
  // Admissions planned in this pass count against a grant's `remaining` at
  // once, so one pass cannot admit more tasks than the grant allows. Only a
  // step that is taken admits: a task passed over for want of a slot leaves
  // the grant whole for the next tick.
  let policy = current.policy;
  // A busy hold is one task's own workspace, so it holds every task but that one.
  // A dispatch planned into a free checkout takes it at once, so one pass
  // cannot send two tasks there (rule 2 of docs/workspace-blocks.md).
  const taken = new Map<string, string>();
  const holder = (task: Item) => (entry: Held) =>
    entry.project === task.project && entry.branch === labelFor(task.id);
  const held = (task: Item) =>
    current.held.some((entry) => entry.project === task.project && !holder(task)(entry)) ||
    (taken.get(task.project) ?? task.id) !== task.id;
  // A task that works in the checkout starts there from a clean tree, unless
  // it already holds the checkout and the changes are its own.
  const intoCheckout = (task: Item) => {
    const workspace = workspaceOf(current.pipelines, task);
    return workspace !== undefined && workspace !== "worktree";
  };
  const enters = (task: Item) =>
    !intoCheckout(task) || current.held.some(holder(task)) || !current.dirty.has(task.project);
  const admitting = (given: Permit, task: string) => {
    if (given._tag === "Granted" && given.admits) policy = admit(policy, given.scope, task);
  };

  const candidates = [
    ...current.review,
    ...current.queue.map((task) => ({ task, worker: undefined })),
  ].flatMap(({ task, worker }) => {
    const pipeline = runningPipeline(current.pipelines, task.project);
    if (pipeline === undefined) return [];
    const placement = place(pipeline, factsOf(task, pipeline));
    return placement._tag === "At" && placement.state === "waiting"
      ? [{ task, worker, pipeline, placement }]
      : [];
  });
  // A stable sort, so tasks the same distance from the end keep their order.
  candidates.sort((first, second) => first.placement.ahead - second.placement.ahead);

  for (const { task, worker, pipeline, placement } of candidates) {
    const { node } = placement;
    if ((node.kind === "land" || node.kind === "done") && !readyToLand(pipeline, task, worker)) {
      continue;
    }
    // A landing moves the operator's branch, which a task working there holds.
    if ((node.kind === "land" || node.kind === "done") && held(task)) continue;
    if (node.kind === "agent") {
      if (held(task) || !enters(task)) continue;
      if (failed.has(task.id) || stale.has(task.id) || current.outOfQuota.has(task.id)) continue;
      if (worker && isBusy(worker)) continue;
    }
    // A check runs on the branch tip, so a live pane that can still commit
    // waits for its turn to end, as it does at a landing.
    if (node.kind === "check" && (held(task) || (worker && isBusy(worker)))) continue;

    // Every gate on the route must permit the step. A gate on `ask` holds the
    // task for one approval of its own step; once approved, a later reading
    // asks about the next gate.
    const gates = placement.gates.map((gate) => ({
      step: gate.step,
      given: permit(policy, current.scopes, task, gate.step),
    }));
    if (gates.some(({ given }) => given._tag === "Denied")) continue;
    const asking = gates.find(({ given }) => given._tag === "Ask");
    if (asking !== undefined) {
      if (asking.step === "author") {
        if (authorAsks >= current.policy.slots) continue;
        authorAsks += 1;
      }
      asks.push({
        task,
        step: asking.step,
        rung:
          node.kind === "land" || node.kind === "done"
            ? lastExit(task)?.rung
            : node.kind === "agent" && node.role === "review"
              ? authoredBy(task)
              : undefined,
      });
      continue;
    }

    const permits = gates.map(({ given }) => given);
    if (node.kind === "land" || node.kind === "done") {
      for (const given of permits) admitting(given, task.id);
      lands.push({ task, worker, permits, block: node });
    } else if (node.kind === "check") {
      for (const given of permits) admitting(given, task.id);
      checks.push({ task, permits, block: node });
    } else if (free > 0 && running.roomAt(task.project, node)) {
      for (const given of permits) admitting(given, task.id);
      free -= 1;
      running.add(task.project, node);
      if (intoCheckout(task)) taken.set(task.project, task.id);
      dispatches.push({ role: node.role, task, permits, block: node });
    }
  }

  return { dispatches, lands, checks, asks };
};

/**
 * How many tasks run at each agent block, per project, from where the tasks
 * stand: a block's id names it only inside its own project's pipeline.
 */
const runningAt = (placed: DispatchState["placed"]) => {
  const counts = new Map<string, number>();
  const key = (project: string, node: AgentNode) => JSON.stringify([project, node.id]);
  const add = (project: string, node: AgentNode) =>
    void counts.set(key(project, node), (counts.get(key(project, node)) ?? 0) + 1);
  for (const { task, placement } of placed) {
    if (
      placement._tag === "At" &&
      placement.state === "running" &&
      placement.node.kind === "agent"
    ) {
      add(task.project, placement.node);
    }
  }
  return {
    add,
    /** Whether the block may start one more task: it has no cap, or room under it. */
    roomAt: (project: string, node: AgentNode) =>
      node.slots === undefined || (counts.get(key(project, node)) ?? 0) < node.slots,
  };
};

const isBusy = (worker: Worker): boolean =>
  worker.state === "working" || worker.state === "blocked";

interface DispatchState {
  readonly workers: ReadonlyArray<Worker>;
  readonly outOfQuota: ReadonlySet<string>;
  readonly queue: ReadonlyArray<Item>;
  readonly held: ReadonlyArray<Held>;
  readonly review: ReadonlyArray<Pick<Active, "task" | "worker">>;
  readonly policy: Policy;
  readonly scopes: Scopes;
  /** Each project's pipeline. A task whose project's pipeline is stopped or absent takes no step. */
  readonly pipelines: ReadonlyMap<string, ProjectPipeline>;
  /** Where every queued and owned task stands, from which each block's running tasks are counted. */
  readonly placed: ReadonlyArray<{ readonly task: Item; readonly placement: Placement }>;
  /** The projects whose checkout has uncommitted changes. */
  readonly dirty: ReadonlySet<string>;
}

/** What one tick would start, land, check, and hold for the operator's approval. */
interface Plan {
  readonly dispatches: ReadonlyArray<PlannedDispatch>;
  readonly checks: ReadonlyArray<PlannedCheck>;
  readonly lands: ReadonlyArray<PlannedLanding>;
  readonly asks: ReadonlyArray<Ask>;
}

/**
 * A step the policy holds for one approval. Derived from each reading and
 * stored nowhere: once the world no longer calls for the step, the ask is gone.
 *
 * `rung` is the rung the decision turns on: the author's for a review, the
 * reviewer's for a landing. An author's rung is chosen at dispatch, so it is
 * absent here.
 */
export interface Ask {
  readonly task: Pick<Item, "id" | "title" | "project">;
  readonly step: Step;
  readonly rung: string | undefined;
}

/**
 * An agent the plan starts, at the agent block the task waits at, with the
 * permit each gate on its route gave. Two gates can hold grants on different
 * scopes, and each grant records its own admission.
 */
interface PlannedDispatch {
  readonly role: AgentNode["role"];
  readonly task: Item;
  readonly permits: ReadonlyArray<Permit>;
  readonly block: AgentNode;
}

/**
 * An approved task the plan ends at its land or done block, with the permit
 * each gate on its route gave.
 */
interface PlannedLanding {
  readonly task: Item;
  readonly worker: Worker | undefined;
  readonly permits: ReadonlyArray<Permit>;
  readonly block: LandNode | DoneNode;
}

/** A check the plan runs on the task's branch tip, with the permit each gate on its route gave. */
interface PlannedCheck {
  readonly task: Item;
  readonly permits: ReadonlyArray<Permit>;
  readonly block: CheckNode;
}

/** A task the tick hands to the operator, and the reason it gives them. */
interface Park {
  readonly task: Item;
  readonly worker: Worker | undefined;
  readonly why: string;
}

/** The pipeline `project` runs, when this reading found one it can run. */
const runningPipeline = (
  pipelines: ReadonlyMap<string, ProjectPipeline>,
  project: string,
): Pipeline | undefined => {
  const found = pipelines.get(project);
  return found?._tag === "Runs" ? found.pipeline : undefined;
};

/**
 * Where the task's route has it work: a worktree of its own, the operator's
 * checkout on its branch, or the operator's checkout on the operator's branch.
 * Nothing when its project's pipeline is stopped or no source takes it.
 */
const workspaceOf = (
  pipelines: ReadonlyMap<string, ProjectPipeline>,
  task: Item,
): Workspace | undefined => {
  const pipeline = runningPipeline(pipelines, task.project);
  return pipeline === undefined ? undefined : routeWorkspace(pipeline, factsOf(task, pipeline));
};

/**
 * Whether the task holds its project's checkout. A task with no worktree
 * occupies the checkout from its first author run until it leaves the
 * pipeline, so no other task starts or lands there in between: its commits
 * sit on the checkout's branch, and a task on the operator's own branch has
 * no undo.
 */
const occupies = (pipelines: ReadonlyMap<string, ProjectPipeline>, task: Item): boolean => {
  const workspace = workspaceOf(pipelines, task);
  return (
    workspace !== undefined &&
    workspace !== "worktree" &&
    task.status !== "done" &&
    task.status !== "canceled" &&
    task.runs.some((run) => run.role === "author")
  );
};

/**
 * A finished branch whose fate is landing rather than the ordinary settle path,
 * whatever its pane is doing: the task is placed at a land or a done block.
 *
 * `reviewing` means the author stopped writing, not that the diff has been read:
 * a pipeline reaches a land block only past a review, and a review is passed
 * only by an approval of the branch tip. So no task size or priority routes
 * around it.
 */
export const awaitingLanding = (pipeline: Pipeline, task: Item): boolean => {
  const placement = place(pipeline, factsOf(task, pipeline));
  return (
    task.status === "reviewing" &&
    placement._tag === "At" &&
    (placement.node.kind === "land" || placement.node.kind === "done")
  );
};

/** What follows a stop with no exit at the block of the task's open run: `retry` unless it says `park`. */
const stoppedAt = (pipeline: Pipeline | undefined, task: Item): "retry" | "park" =>
  openAgentOf(pipeline, task)?.block.stopped ?? "retry";

/**
 * The exit the agent of the task's open run named, as the drawing declares it
 * now: nothing when no agent named one, or the block or exit is gone.
 */
const openExitOf = (pipeline: Pipeline | undefined, task: Item): Exit | undefined => {
  const open = openAgentOf(pipeline, task);
  return open?.block.exits.find((exit) => exit.name === open.run.ending);
};

/** The task's open agent run and its block in the drawing, while that block is still an agent. */
const openAgentOf = (
  pipeline: Pipeline | undefined,
  task: Item,
): { readonly run: Run; readonly block: AgentNode } | undefined => {
  const run = task.runs.findLast((candidate) => candidate.open && candidate.role !== "check");
  const block = pipeline?.nodes.find((node) => node.id === run?.node);
  return run !== undefined && block?.kind === "agent" ? { run, block } : undefined;
};

/** The agent of the task's open run finished its block, and settle has not yet closed its run. */
const endedAt = (pipeline: Pipeline, task: Item): boolean => {
  const placement = place(pipeline, factsOf(task, pipeline));
  return placement._tag === "At" && placement.node.kind === "agent" && placement.state === "ended";
};

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
  DateTime.isLessThan(DateTime.fromDateUnsafe(task.lastActivityAt), cutoff);

/**
 * A finished branch foreman may merge on this tick.
 *
 * Liveness belongs in the predicate rather than in a check beside it, because
 * the plan and settle must agree about the same task. An agent that has
 * handed its work back still has a turn to finish — a closing message, a last
 * prog call — and landing ends by closing the workspace, which for a worktree
 * worker runs `worktree remove --force` and deletes the directory out from
 * under a running process. Status and verdict are both durable, so waiting one
 * tick costs nothing and loses nothing.
 */
export const readyToLand = (pipeline: Pipeline, task: Item, worker: Worker | undefined): boolean =>
  awaitingLanding(pipeline, task) && (worker === undefined || worker.state !== "working");

/**
 * What the dashboard must ask about.
 *
 * Three kinds, and each answers differently. A claimed task with a by-* label
 * and an empty workspace is an author that vanished and can be retried; a
 * reviewing task with an open review run and an empty workspace is a reviewer
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
/**
 * Whether a claimed task is the fleet's: foreman labelled its author, or one of
 * its workers holds it. Any other claim was made by hand or by another session
 * and is that person's work in progress, not an agent the fleet is running.
 */
export const isFleetWork = (claimed: Active): boolean =>
  claimed.worker !== undefined || authoredBy(claimed.task) !== undefined;

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
      // A reviewer that named its exit did not vanish, it finished: the task
      // waits on the checkout being clean, not on an answer, and its pane is
      // gone precisely because there was nothing left for it to do.
      !reviewerNamed(task) &&
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
  return {
    failures: new Map(failures).set(task, { detail, count }),
    count,
    report,
  };
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
 * survivors are put in landing order. `lastActivityAt` is when a done task
 * was last touched, which for a done task is when it landed.
 */
export const landedColumn = (
  landed: ReadonlyArray<Item>,
  now: DateTime.DateTime,
  windowDays: number,
): ReadonlyArray<Item> => {
  const cutoff = DateTime.subtract(now, { days: windowDays });
  return landed
    .filter((item) => DateTime.isGreaterThan(DateTime.fromDateUnsafe(item.lastActivityAt), cutoff))
    .sort((first, second) => second.lastActivityAt.getTime() - first.lastActivityAt.getTime());
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
 * the reviewer confirms the already-done one against the trunk and the research
 * one against its evidence, and an ordinary rejection sends a false one back.
 */
export const reviewable = (
  reviewing: ReadonlyArray<Active>,
  committed: ReadonlySet<string>,
): {
  readonly review: ReadonlyArray<Active>;
  readonly unbacked: ReadonlyArray<Active>;
} => {
  const authored = reviewing.filter(({ task }) => authoredBy(task) !== undefined);
  const readable = ({ task }: Active) =>
    committed.has(task.id) || claimsAlreadyDone(task) || isResearch(task);
  return {
    review: authored.filter(readable),
    unbacked: authored.filter((active) => !readable(active)),
  };
};

/**
 * The workspaces this dispatcher owns, out of a roster that shows every dispatcher's.
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
 * The workspaces this dispatcher may act on, split out of a roster that shows
 * every dispatcher's.
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
): {
  readonly owned: ReadonlyArray<Owned>;
  readonly workers: ReadonlyArray<Worker>;
} => {
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
  readonly runs: ReadonlyArray<Run>;
}

/** History read above a stopped agent's screen when looking for a usage wall. */
const WALL_READ_LINES = 40;

/** The account a stopped author ran on, and the wall text its screen ended on. */
interface UsageWall {
  readonly provider: string;
  readonly text: string;
}

/** A rung, as the multiplexer needs it: which program, and which model inside it. */
const spawnAs = (rung: Rung, prompt: string, role: AgentRole): SpawnOptions => ({
  kind: rung.harness,
  model: rung.model,
  thinking: rung.thinking,
  prompt,
  role,
});

/** Everything the dashboard draws, and everything the loop decided from. */
export interface FleetState {
  /** The projects this reading covers; see `src/projects.ts`. */
  readonly projects: ReadonlyArray<Project>;
  /** Ready work in dispatch order. */
  readonly queue: ReadonlyArray<Item>;

  /**
   * Tasks parked at the operator's rung, above the last model in the ladder.
   *
   * They arrive by climbing off the top — nothing configured could finish them
   * — or by being pinned there by hand, which is what work that was never
   * specified needs: dispatching it once to discover that wastes a run. Either
   * way the answer is a person writing the decision into the task and then
   * removing the label.
   */
  readonly yours: ReadonlyArray<Item>;
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
  /** The operator's policy as this reading found it. */
  readonly policy: Policy;
  /** Why the policy file could not be read, which is why the fleet is paused. */
  readonly policyError: string | undefined;
  /** Each project's pipeline as this reading found it; a stopped one says why. */
  readonly pipelines: ReadonlyMap<string, ProjectPipeline>;
  /**
   * Where each queued, claimed and reviewing task stands in its project's
   * pipeline: what the plan decided from. A task in a stopped project is
   * `Outside`.
   */
  readonly placed: ReadonlyArray<{ readonly task: Item; readonly placement: Placement }>;
  /** Each grant's scope, mapped to the unfinished tasks it reaches. */
  readonly scopes: Scopes;
  /** Steps the policy holds for one approval; see `Ask`. */
  readonly asks: ReadonlyArray<Ask>;

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
  /** For a `busy` hold, the task branch the checkout has out; that task is not held. */
  readonly branch?: string;
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

export interface InterventionTarget {
  readonly task: Item | Item;
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

  /** The approved branches the plan lands; settle runs them. */
  readonly lands: ReadonlyArray<PlannedLanding>;

  /** The checks the plan runs on branch tips; settle runs them. */
  readonly checks: ReadonlyArray<PlannedCheck>;

  /** The merged branches no live task still points at, for the sweep. */
  readonly prunable: ReadonlyArray<{
    readonly project: string;
    readonly directory: string;
    readonly branch: string;
  }>;
}

/** The state before the first reading: nothing read, under the default policy. */
export const EMPTY_FLEET: FleetState = {
  projects: [],
  queue: [],
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
  policy: DEFAULT_POLICY,
  policyError: undefined,
  pipelines: new Map(),
  placed: [],
  scopes: new Map(),
  asks: [],
  observedAt: undefined,
};

/**
 * Where a task's new workspace goes on its route: a worktree of its own, the
 * operator's checkout put on the task's branch, or nothing for a task that
 * works on the operator's own branch, which attaches to the checkout as it is.
 */
const newWorkspace = (
  workspace: Workspace | undefined,
  project: Project,
  task: string,
): string | undefined =>
  workspace === "none"
    ? undefined
    : workspace === "branch"
      ? project.directory
      : directoryFor(project.name, task);
