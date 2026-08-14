import { DateTime, Duration, Effect, Ref, Schedule, SubscriptionRef } from "effect";
import { Settings } from "./config.ts";
import { Fleet, labelFor, type Worker } from "./fleet.ts";
import { Prompts } from "./prompt.ts";
import { interleave } from "./queue.ts";
import { Repository } from "./repository.ts";
import {
  agentLog,
  authoredBy,
  isEscalated,
  isOnboarding,
  type Item,
  needsReview,
  ONBOARD,
  Prog,
  type ReadyTask,
  reviewedBy,
} from "./prog.ts";

/**
 * The loop that replaces the human, and the commands a dashboard can give it.
 *
 * Foreman remembers nothing between ticks. What it is doing is read back every
 * time from the multiplexer's workspaces and the task store, because a
 * dispatcher whose memory is authoritative loses the fleet when it restarts —
 * and this one restarts whenever its dashboard is closed. Everything the loop
 * decides is therefore derivable by anyone else looking at the same world.
 */
export class Dispatcher extends Effect.Service<Dispatcher>()("Dispatcher", {
  dependencies: [Prog.Default, Prompts.Default, Repository.Default],
  effect: Effect.gen(function* () {
    const settings = yield* Settings;
    const fleet = yield* Fleet;
    const prog = yield* Prog;
    const prompts = yield* Prompts;
    const repository = yield* Repository;

    // The one piece of genuinely non-derivable state: whether the operator has
    // asked foreman to stop taking on new work. Nothing in the world records
    // an intention.
    const paused = yield* Ref.make(false);
    const state = yield* SubscriptionRef.make(empty);

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
      const current = yield* observe;
      yield* SubscriptionRef.set(state, current);

      yield* settle(current);
      yield* reclaim(current);
      if (yield* Ref.get(paused)) return;
      yield* fill(yield* observe);
    });

    /** The world as it is right now, with no interpretation applied. */
    const observe = Effect.gen(function* () {
      const workers = yield* fleet.roster;
      const byTask = new Map(workers.map((worker) => [worker.task, worker] as const));

      const workerFor = (task: Item): Worker | undefined => {
        const worker = byTask.get(task.id);
        if (!worker) return undefined;
        const state = reviewedBy(task) ? worker.reviewState : worker.authorState;
        return { ...worker, state: state ?? "gone" };
      };

      // Status-filtered lists lose a task at the exact moment it moves to a
      // different column. Owned workspaces therefore read their task directly;
      // this is the durable join that lets terminal work be settled.
      const owned = yield* Effect.forEach(workers, (worker) =>
        prog.show(worker.task).pipe(
          Effect.map((task) => {
            const current = workerFor(task) ?? { ...worker, state: "gone" as const };
            return [{ task, worker: current, kind: reviewedBy(task) ?? authoredBy(task) }] as const;
          }),
          Effect.catchAll((error) =>
            Effect.logWarning(`skipped workspace ${worker.workspace}: ${error}`).pipe(
              Effect.as<ReadonlyArray<Owned>>([]),
            ),
          ),
        ),
      ).pipe(Effect.map((items) => items.flat()));

      // Which checkouts the operator is presently working in. Read every tick
      // like everything else: you clean a tree up between two ticks and the
      // project comes back on its own.
      const held = yield* Effect.forEach(settings.projects, (project) =>
        repository.isClean(project.directory).pipe(
          Effect.map((clean) => (clean ? [] : [project.name])),
          // A checkout foreman cannot read is a checkout it must not merge
          // into either, so an unreadable repository is held rather than free.
          Effect.catchAll((error) =>
            Effect.logWarning(`holding ${project.name}: ${error}`).pipe(Effect.as([project.name])),
          ),
        ),
      ).pipe(Effect.map((names) => names.flat()));

      const claimed = yield* eachProject((project) => prog.claimed(project.name));
      const reviewing = yield* eachProject((project) => prog.awaitingReview(project.name));
      // One query, gated by prog: `ready` returns a task only once every task
      // blocking it is done, whichever project that blocker lives in. The
      // allowlist is applied afterwards, to prog's answer rather than to the
      // question, so a blocker outside the fleet still holds its dependents.
      const queue = yield* prog.ready();
      const landed = yield* eachProject((project) => prog.landed(project.name));

      // prog list has no limit, so the landed column is bounded here instead
      // of in the query. Anything outside the window is history, not news.
      const now = yield* DateTime.now;
      const landedWindow = DateTime.subtract(now, { days: settings.landedWindow });

      const active = (items: ReadonlyArray<Item>) =>
        items.map((task) => ({
          task,
          worker: workerFor(task),
          kind: reviewedBy(task) ?? authoredBy(task),
        }));

      return {
        workers,
        owned,
        held,
        // Salvage runs stand in a directory a person is using, so they start
        // when that person asks and never because a slot came free.
        queue: interleave(
          queue.filter((task) => !isOnboarding(task)),
          settings.projects.map((project) => project.name),
        ),
        working: active(claimed),
        // `reviewing` is a public task status. Attribution is the durable proof
        // that this branch was authored by foreman and has something to review.
        review: active(reviewing.filter((task) => authoredBy(task) !== undefined)),
        landed: landed.filter((item) =>
          DateTime.greaterThan(DateTime.unsafeFromDate(item.last_activity_at), landedWindow),
        ),
        // A dispatched author or reviewer whose workspace is empty did not
        // produce a verdict. Foreman cannot tell a crash from a person closing
        // the pane to take over, so the dashboard asks instead.
        decisions: [
          ...active(claimed.filter((task) => authoredBy(task) !== undefined)).filter(
            ({ worker }) => worker === undefined || worker.state === "gone",
          ),
          ...active(reviewing.filter((task) => reviewedBy(task) !== undefined)).filter(
            ({ worker }) => worker === undefined || worker.state === "gone",
          ),
        ],
        paused: yield* Ref.get(paused),
      } satisfies Observation;
    });

    /**
     * Resolves every worker that stopped, by re-reading its task rather than
     * by interpreting anything the agent printed.
     *
     * An author handing off to review is a success, not a completion: the task
     * stays alive and the review queue picks it up next tick.
     */
    const settle = (current: Observation) =>
      Effect.forEach(
        current.owned.filter(({ worker }) => worker.state !== "working"),
        ({ task, worker, kind }) =>
          Effect.gen(function* () {
            if (task.status === "done" || task.status === "canceled") {
              yield* fleet.notify(
                task.status === "done" ? "Task landed" : "Task canceled",
                `${task.id} ${task.title}`,
              );
              return yield* fleet.close(worker);
            }

            const reviewer = reviewedBy(task);
            if (reviewer && task.status === "open") {
              yield* prog.escalate(task.id);
              return yield* fleet.notify(
                "Review returned",
                `${task.id} was sent back by ${reviewer} — escalated for its next author`,
              );
            }

            // An empty workspace says nothing about why the agent vanished.
            // It remains claimed until an operator decides or it goes stale.
            if (worker.state === "gone") return;

            if (worker.state === "blocked") {
              // Approvals stay with the operator. Foreman says where to look
              // and then leaves the worker exactly as it is.
              return yield* fleet.notify("Worker blocked", `${task.id} needs you — ${task.title}`);
            }

            if (task.status === "reviewing") {
              if (!reviewer) {
                return yield* fleet.notify("Ready for review", `${task.id} ${task.title}`);
              }

              yield* prog.log(
                task.id,
                `foreman: reviewer ${reviewer} stopped without a verdict. Returned to the queue and escalated.`,
              );
              yield* prog.escalate(task.id);
              yield* prog.release(task.id);
              return yield* fleet.notify(
                "Review returned",
                `${task.id} reviewer stopped without a verdict — back in the queue`,
              );
            }

            // A reviewer can explicitly return work with `prog open`. Keep the
            // workspace: the next author must continue from the same branch.
            if (task.status !== "in_progress") return;

            // Settled without a verdict on a task that is still open. The
            // agent stopped of its own accord, so unlike a vanished worker
            // this is evidence, and the task goes back to the queue with what
            // it learned attached.
            yield* prog.log(
              task.id,
              `foreman: ${kind ?? "agent"} stopped without finishing (status ${task.status}). Returned to the queue.`,
            );
            yield* prog.escalate(task.id);
            yield* prog.release(task.id);
            yield* fleet.notify(
              "Task returned",
              `${task.id} stopped unfinished — back in the queue`,
            );
          }).pipe(
            Effect.catchAll((error) => Effect.logWarning(`settling ${task.id} failed: ${error}`)),
          ),
        { discard: true },
      );

    /**
     * Returns claims that nobody is working on any more.
     *
     * Ownership decides this, not age: a task with a live workspace is being
     * worked on by definition. Age only guards the claims foreman does not
     * own, so a claim made by hand in another pane is not stolen from someone
     * who is still typing — and a claim awaiting an operator's decision is
     * left alone until it goes properly stale.
     */
    const reclaim = (current: Observation) =>
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
              DateTime.lessThan(DateTime.unsafeFromDate(task.last_activity_at), cutoff),
          ),
          ({ task, worker }) =>
            Effect.gen(function* () {
              yield* prog.log(
                task.id,
                `foreman: claim released — no activity since ${task.last_activity_at.toISOString()}.`,
              );
              yield* prog.release(task.id);
              if (worker) yield* fleet.close(worker);
              yield* Effect.logInfo(`reclaimed ${task.id} (${task.project})`);
            }).pipe(
              Effect.catchAll((error) =>
                Effect.logWarning(`reclaiming ${task.id} failed: ${error}`),
              ),
            ),
          { discard: true },
        );
      });

    /**
     * Claims work for every free slot, review first.
     *
     * Tasks in a held project are passed over. Both roles end by merging into
     * that checkout, so dispatching there would put an agent's merge against
     * the operator's own edits — and the operator would find their branch
     * moving under them mid-change. The tasks stay in the queue, and the
     * dashboard names the project so the reason is visible rather than
     * mysterious.
     */
    const fill = (current: Observation) =>
      Effect.gen(function* () {
        const busy = current.workers.filter(
          (worker) => worker.state === "working" || worker.state === "blocked",
        ).length;
        let free = settings.slots - busy;
        if (free <= 0) return;

        for (const { task, worker } of current.review) {
          if (free <= 0) return;
          if (current.held.includes(task.project)) continue;
          if (reviewedBy(task) !== undefined) continue;
          if (worker && (worker.state === "working" || worker.state === "blocked")) continue;
          yield* dispatchReview(task, authoredBy(task)).pipe(
            Effect.catchAll((error) =>
              Effect.logWarning(`review dispatch failed ${task.id}: ${error}`),
            ),
          );
          free -= 1;
        }

        const available = current.queue.filter((task) => !current.held.includes(task.project));
        for (const task of available.slice(0, free)) {
          yield* dispatchAuthor(task).pipe(
            Effect.catchAll((error) =>
              Effect.logWarning(`dispatching ${task.id} failed: ${error}`),
            ),
          );
        }
      });

    const dispatchAuthor = (task: ReadyTask) =>
      Effect.gen(function* () {
        const project = projectFor(task.project);
        if (!project) return;

        // Cheap by default; frontier only where cheap has already been tried
        // and failed. The task carries that history, so it survives restarts
        // and you can force it by hand with the label.
        const kind = isEscalated(task) ? settings.escalateTo : settings.author;

        // The workspace opens before the claim. If it opened after, a task
        // would briefly be claimed with nothing to show for it, and that state
        // is indistinguishable from an abandoned claim.
        const worker = yield* fleet.open({
          task: task.id,
          repository: project.directory,
          branch: labelFor(task.id),
          directory: directoryFor(task.project, task.id),
        });

        const prompt = yield* prompts.author(
          task,
          worker.directory,
          project.directory,
          needsReview(task),
        );
        yield* prog.claim(task.id);
        yield* prog.attribute(task.id, kind).pipe(Effect.tapError(() => prog.release(task.id)));
        const agent = yield* fleet.spawn(worker, { kind, prompt, role: "author" }).pipe(
          // The agent never started, so the claim would strand the task until
          // the stale sweep noticed. Hand it back immediately instead.
          Effect.tapError(() => prog.release(task.id)),
        );
        yield* prog.log(task.id, agentLog("author", agent));
        yield* Effect.logInfo(
          `dispatched ${task.id} (${task.project}) to ${kind} in ${worker.workspace}`,
        );
      });

    const dispatchReview = (task: Item, author: string | undefined) =>
      Effect.gen(function* () {
        const project = projectFor(task.project);
        if (!project) return;

        const kind = reviewerFor(author);
        const worker = yield* fleet.open({
          task: task.id,
          repository: project.directory,
          branch: labelFor(task.id),
          directory: directoryFor(task.project, task.id),
        });

        const prompt = yield* prompts.review(task, worker.directory, project.directory);
        yield* prog.assignReview(task.id, kind);
        const agent = yield* fleet
          .spawn(worker, { kind, prompt, role: "review" })
          .pipe(Effect.tapError(() => prog.clearReview(task.id)));
        yield* prog.log(task.id, agentLog("review", agent));
        yield* Effect.logInfo(`review of ${task.id} (${task.project}) to ${kind}`);
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

    const dispatchOnboard = (task: Item, project: Project) =>
      Effect.gen(function* () {
        const kind = settings.escalateTo;

        // Attached, not a worktree: the work being rescued exists only in this
        // checkout, so a copy of the last commit would show the agent nothing.
        const worker = yield* fleet.attach({ task: task.id, repository: project.directory });
        const prompt = yield* prompts.onboard(task, project.directory);

        yield* prog.claim(task.id);
        yield* prog.attribute(task.id, kind).pipe(Effect.tapError(() => prog.release(task.id)));
        const agent = yield* fleet
          .spawn(worker, { kind, prompt, role: "author" })
          .pipe(Effect.tapError(() => prog.release(task.id)));
        yield* prog.log(task.id, agentLog("author", agent));
        yield* Effect.logInfo(`onboarding ${project.name} as ${task.id} with ${kind}`);
      });

    /**
     * Picks the reviewer for work by a given kind.
     *
     * Without a configured mapping, escalating a cheap author to an expensive
     * reviewer is where most of the value is. A uniform fleet reviews itself,
     * which still helps: the reviewer arrives with no sunk cost in the
     * implementation and reads the diff as a stranger would.
     */
    const reviewerFor = (author: string | undefined): string =>
      (author ? settings.reviewers[author] : undefined) ?? settings.escalateTo;

    const projectFor = (name: string) =>
      settings.projects.find((candidate) => candidate.name === name);

    const eachProject = <A>(read: (project: Project) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
      Effect.forEach(settings.projects, (project) =>
        read(project).pipe(
          // One unreadable project must not blind foreman to the other seven.
          Effect.catchAll((error) =>
            Effect.logWarning(`skipped ${project.name}: ${error}`).pipe(
              Effect.as<ReadonlyArray<A>>([]),
            ),
          ),
        ),
      ).pipe(Effect.map((perProject) => perProject.flat()));

    return {
      /** What the dashboard renders. Replaced whole on every tick. */
      state,

      /** Runs until interrupted. */
      run: Effect.gen(function* () {
        yield* Effect.logInfo(
          `foreman up: ${settings.slots} slots over ${settings.projects.length} projects, polling every ${settings.pollInterval}s`,
        );
        return yield* tick.pipe(
          Effect.repeat(Schedule.spaced(Duration.seconds(settings.pollInterval))),
        );
      }),

      /** Stops filling slots. Live workers are left to finish. */
      pause: Ref.set(paused, true),
      resume: Ref.set(paused, false),

      /** Brings a task's workspace to the front so you can take over. */
      focus: (worker: Worker) => fleet.focus(worker),

      /**
       * Salvages the uncommitted work in one project, so it can be dispatched
       * to again. Offered for any held project, including one being edited
       * right now: only the operator knows whether they have stepped away.
       */
      onboard: (project: string) =>
        Effect.gen(function* () {
          const found = projectFor(project);
          if (found) yield* onboard(found);
        }),

      /** Starts a fresh agent on a task whose worker vanished. */
      retry: (task: Item) =>
        Effect.gen(function* () {
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

          const worker = yield* fleet.roster.pipe(
            Effect.map((workers) => workers.find((candidate) => candidate.task === task.id)),
          );
          if (!worker) return;
          const project = projectFor(task.project);
          if (!project) return;
          const kind = isEscalated(task) ? settings.escalateTo : settings.author;
          const prompt = yield* prompts.author(
            task,
            worker.directory,
            project.directory,
            needsReview(task),
          );
          const agent = yield* fleet.spawn(worker, { kind, prompt, role: "author" });
          yield* prog.attribute(task.id, kind);
          yield* prog.log(task.id, agentLog("author", agent));
        }),

      /** Hands a task back to the queue and takes its workspace down. */
      release: (task: Item) =>
        Effect.gen(function* () {
          yield* prog.release(task.id);
          const worker = yield* fleet.roster.pipe(
            Effect.map((workers) => workers.find((candidate) => candidate.task === task.id)),
          );
          if (worker) yield* fleet.close(worker);
        }),

      /** Marks a task for the frontier model next time it is picked up. */
      escalate: (task: Item) => prog.escalate(task.id),
    } as const;
  }),
}) {}

/** Everything the dashboard draws, and everything the loop decided from. */
export interface FleetState {
  readonly queue: ReadonlyArray<ReadyTask>;
  readonly working: ReadonlyArray<Active>;
  readonly review: ReadonlyArray<Active>;
  readonly landed: ReadonlyArray<Item>;
  readonly decisions: ReadonlyArray<Active>;

  /**
   * Projects whose checkout has uncommitted changes to tracked files.
   *
   * The operator is working there, so their tasks stay in the queue until the
   * tree is clean again. Naming them is the point: a queue that stops moving
   * for a reason nobody can see reads as a broken dispatcher.
   */
  readonly held: ReadonlyArray<string>;
  readonly paused: boolean;
}

/** A task and the workspace running it, if the multiplexer still has one. */
export interface Active {
  readonly task: Item;
  readonly worker: Worker | undefined;
  readonly kind: string | undefined;
}

interface Owned {
  readonly task: Item;
  readonly worker: Worker;
  readonly kind: string | undefined;
}

interface Observation extends FleetState {
  readonly workers: ReadonlyArray<Worker>;
  readonly owned: ReadonlyArray<Owned>;
}

const empty: FleetState = {
  queue: [],
  working: [],
  review: [],
  landed: [],
  decisions: [],
  held: [],
  paused: false,
};

interface Project {
  readonly name: string;
  readonly directory: string;
}

/**
 * Where a task's worktree lives. Under the state directory rather than inside
 * the repository: an in-tree worktree would mean editing .gitignore in every
 * project foreman touches, and a stray checkout is far more confusing inside a
 * repo than outside it.
 */
const directoryFor = (project: string, task: string): string =>
  `${process.env["XDG_STATE_HOME"] ?? `${process.env["HOME"]}/.local/state`}/foreman/worktrees/${project}/${task}`;
