import { DateTime, Duration, Effect, Queue, Ref, SubscriptionRef } from "effect";
import { Settings } from "./config.ts";
import {
  type AgentRole,
  directoryFor,
  Fleet,
  labelFor,
  type SpawnOptions,
  taskOf,
  type Worker,
} from "./fleet.ts";
import { Prompts } from "./prompt.ts";
import { interleave } from "./queue.ts";
import { Repository } from "./repository.ts";
import {
  above,
  authorFor,
  below,
  HUMAN,
  isYours,
  reviewerFor,
  type Rung,
  topOf,
} from "./ladder.ts";
import {
  agentLog,
  authoredBy,
  isApproved,
  isOnboarding,
  isPlan,
  type Item,
  needsReview,
  ONBOARD,
  Prog,
  type ReadyTask,
  reviewedBy,
  rungOf,
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
  accessors: true,
  effect: Effect.gen(function* () {
    const settings = yield* Settings;
    const fleet = yield* Fleet;
    const prog = yield* Prog;
    const prompts = yield* Prompts;
    const repository = yield* Repository;

    // The one piece of genuinely non-derivable state: whether the operator has
    // asked foreman to stop taking on new work. Nothing in the world records
    // an intention.
    //
    // It starts true unless the operator said otherwise on the command line.
    // Settling and reclaiming run while paused, so a fresh start lands what is
    // finished and tidies what died before it asks for anything new — and the
    // operator who opened the screen to drain the fleet is not racing the first
    // tick to press pause.
    //
    // `--running` is how a restart inherits the answer. Under `bun --watch` the
    // daemon restarts whenever foreman's own source changes — which includes
    // landing a task into foreman's own checkout — so pausing by default parked
    // the fleet after every landing and waited for a person. The command line is
    // the only thing a restart carries over, which is why the intention is
    // stated there and nowhere durable: recording it would make foreman
    // remember, and the operator's last keypress is not a fact about the world.
    const paused = yield* Ref.make(!settings.running);
    const state = yield* SubscriptionRef.make(empty);

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
      yield* tidy(current);
      yield* reclaim(current);
      if (yield* Ref.get(paused)) return;
      yield* fill(yield* observe);
    });

    /** The world as it is right now, with no interpretation applied. */
    const observe = Effect.gen(function* () {
      const roster = yield* fleet.roster;

      // Every workspace's task, read once. The roster is joined to the store
      // rather than filtered through status queries, because a task leaves a
      // column's status at the exact moment it moves to another — the durable
      // join is what lets work that has reached a terminal state still be
      // settled.
      const tasks = yield* Effect.forEach(roster, (worker) =>
        prog.show(worker.task).pipe(
          Effect.map((task) => [[worker.task, task]] as const),
          Effect.catchAll((error) =>
            Effect.logWarning(`skipped workspace ${worker.workspace}: ${error}`).pipe(
              Effect.as<ReadonlyArray<readonly [string, Item]>>([]),
            ),
          ),
        ),
      ).pipe(Effect.map((entries) => new Map(entries.flat())));

      // The roster is every daemon's: herdr lists every workspace labelled
      // `foreman/*` whoever opened it, and a label records no ownership — two
      // foremen against different configs are not competing for the same
      // slots. The config's project set is the only ownership the world
      // records, so it is what scopes everything read back. A foreign
      // workspace is another daemon's live work: counted it would fill this
      // daemon's slots, and settled or reclaimed it would move a task across
      // the boundary the config draws.
      const managed = new Set(settings.projects.map((project) => project.name));
      const { owned, workers } = scopeRoster(roster, tasks, managed);
      const ownedByTask = new Map(owned.map((entry) => [entry.task.id, entry]));

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
      // Authorship, not availability. A branch whose commits the checkout
      // already has still proves the author wrote something — and a task in
      // review whose branch was merged by hand needs landing, not requeueing.
      const committed = new Set(
        branches.filter((entry) => !entry.empty).map((entry) => entry.task),
      );

      // Every other column is read from prog, which forgets a branch the
      // moment its task is closed, reclaimed or deleted — so the commits
      // themselves are asked instead. A task the fleet still holds is not
      // stranded: the queue will dispatch an author onto that same branch, and
      // a claim with no worker is already a decision the operator is being
      // asked about.
      const accounted = new Set([...claimed, ...reviewing, ...queue].map((task) => task.id));
      const orphans = yield* Effect.forEach(
        branches.filter(
          (entry) => !entry.merged && !accounted.has(entry.task) && !ownedByTask.has(entry.task),
        ),
        ({ branch, task, project }) =>
          prog.show(task).pipe(
            Effect.map((item) => ({
              project,
              branch,
              task,
              title: item.title,
              status: item.status,
            })),
            // A branch whose task was deleted outright. It is the reason to
            // read git rather than prog, so it is shown, not dropped.
            Effect.orElseSucceed(() => ({
              project,
              branch,
              task,
              title: undefined,
              status: undefined,
            })),
          ),
      );

      // What the sweep may delete: a merged ref for work nothing in the
      // pipeline is still pointing at. The branch is a task's only proof that
      // its author wrote anything, and a merge can arrive from outside foreman
      // — a hand-merged branch swept on the tick before its reviewer settles
      // leaves that task looking like one nobody ever committed to.
      const prunable = branches.filter(
        (entry) => entry.merged && !accounted.has(entry.task) && !ownedByTask.has(entry.task),
      );

      // Work at the operator's rung is ready by every measure prog knows and
      // still must not be dispatched: it is waiting on a decision no agent can
      // make. Split here rather than in fill, so the dashboard can say where it
      // went instead of leaving it to look like a queue that stopped moving.
      const dispatchable = queue.filter((task) => !isYours(settings.ladder, rungOf(task)));

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

      return {
        workers,
        owned,
        held,
        // Salvage runs stand in a directory a person is using, so they start
        // when that person asks and never because a slot came free.
        queue: interleave(
          dispatchable.filter((task) => !isOnboarding(task)),
          settings.projects.map((project) => project.name),
        ),
        yours: queue.filter(
          (task) => isYours(settings.ladder, rungOf(task)) && managed.has(task.project),
        ),
        working: claimedActive,
        ...reviewable(reviewingActive, committed),
        committed,
        prunable,
        orphans,
        landed: landed.filter((item) =>
          DateTime.greaterThan(DateTime.unsafeFromDate(item.last_activity_at), landedWindow),
        ),
        decisions: decisionsOf(claimedActive, reviewingActive, owned),
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
      Effect.gen(function* () {
        yield* Effect.forEach(
          current.review.filter(({ task, worker }) => readyToLand(task, worker)),
          ({ task }) => land(task),
          { discard: true },
        );

        // An author that handed back an empty branch did not finish, whatever
        // it said by moving the task. Sending a reviewer costs a second agent
        // to read an empty diff, and a trivial task skips review entirely and
        // would land a merge commit with nothing in it. So the task goes back
        // to the queue, which is where unfinished work belongs.
        yield* Effect.forEach(
          current.unbacked,
          ({ task, kind }) =>
            Effect.gen(function* () {
              yield* prog.log(
                task.id,
                `foreman: ${kind ?? "the author"} handed ${task.id} back for review with nothing committed on ${labelFor(task.id)}. Returned to the queue — there is no work to review.`,
              );
              yield* prog.release(task.id);
              yield* teardown(task);
            }),
          { discard: true },
        );

        yield* Effect.forEach(
          current.owned.filter(
            ({ task, worker }) => !awaitingLanding(task) && worker.state !== "working",
          ),
          ({ task, worker, kind }) =>
            Effect.gen(function* () {
              if (task.status === "done" || task.status === "canceled") {
                yield* fleet.notify(
                  task.status === "done" ? "Task landed" : "Task canceled",
                  `${task.id} ${task.title}`,
                );
                return yield* teardown(task);
              }

              const reviewer = reviewedBy(task);
              if (reviewer && task.status === "open") {
                // Clearing the label is what ends the review, and it has to
                // happen here. Everything else on this path stays as it is by
                // design — the task is already open, and the workspace is kept
                // so the next author continues from the same branch — so the
                // label is the only thing that can record that the review is
                // over. Leave it and every condition above is still true next
                // tick: foreman climbs the task another rung every poll until
                // it runs out of ladder and parks on the operator, having
                // learned nothing about it.
                yield* prog.clearReview(task.id);
                yield* prog.log(
                  task.id,
                  `foreman: reviewer ${reviewer} sent ${task.id} back with findings. Returned to the queue one rung up — read the review notes above and continue from ${labelFor(task.id)}.`,
                );
                yield* climb(task);
                return yield* fleet.notify(
                  "Review returned",
                  `${task.id} was sent back by ${reviewer} — one rung up for its next author`,
                );
              }

              // A worker that vanished said nothing, but the directory it left
              // behind did. Whether anything is in it decides everything here,
              // and neither answer is a reason to climb: an agent killed by the
              // machine it ran on is no evidence its model was too weak.
              if (worker.state === "gone") {
                // Except when the directory is not foreman's. A salvage run
                // works in the checkout the operator also edits, so what is
                // uncommitted there is theirs, and closing that workspace on
                // the strength of it would delete a person's work.
                if (!worker.worktree) return;

                if (
                  current.committed.has(task.id) ||
                  (yield* repository.holdsWork(worker.worktree))
                ) {
                  // The claim goes back but the workspace stays. herdr adopts a
                  // workspace by its label, so the next author foreman sends
                  // opens in this same directory, on this same branch, with
                  // these edits still in it — and picks up where the last one
                  // stopped instead of writing them a second time.
                  yield* prog.log(
                    task.id,
                    `foreman: ${kind ?? "the author"} vanished mid-task and left unfinished work in ${worker.worktree}. Returned to the queue with the worktree intact — read git status and git log ${labelFor(task.id)} before you plan anything, and continue from what is there.`,
                  );
                  return yield* prog.release(task.id);
                }

                yield* prog.log(
                  task.id,
                  `foreman: ${kind ?? "the author"} vanished without writing anything — no commits on ${labelFor(task.id)} and an untouched worktree. Returned to the queue for a fresh start.`,
                );
                yield* prog.release(task.id);
                return yield* teardown(task);
              }

              // Approvals stay with the operator, so a blocked worker is left
              // exactly as it is — and is not announced. herdr raises its own
              // alert the moment an agent blocks, and foreman knows nothing
              // herdr does not. A second notification for one event is one the
              // operator learns to dismiss, and because this path changes
              // nothing, the condition is still true next tick: it would fire
              // again every poll until they answered.
              if (worker.state === "blocked") return;

              if (task.status === "reviewing") {
                // An author that handed off and stopped is an agent event, and
                // herdr has already said so. Foreman's part is to dispatch the
                // reviewer on the next fill, which needs no announcement — and
                // announcing it here would repeat every poll until a slot came
                // free, because waiting for review changes nothing to observe.
                if (!reviewer) return;

                yield* prog.log(
                  task.id,
                  `foreman: reviewer ${reviewer} stopped without a verdict. Returned to the queue one rung up.`,
                );
                yield* climb(task);
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
              yield* climb(task);
              yield* prog.release(task.id);
              // The workspace goes with the decision. A settled agent is still
              // running idle, and herdr has no way to stop it without closing
              // the pane it runs in — which, for an author, is the workspace's
              // own pane. So closing the workspace is what dismissing the agent
              // means now: the worktree is removed with it, and the next author
              // continues from the branch tip rather than from uncommitted
              // edits.
              yield* teardown(task);
              yield* fleet.notify(
                "Task returned",
                `${task.id} stopped unfinished — back in the queue`,
              );
            }).pipe(
              Effect.catchAll((error) => Effect.logWarning(`settling ${task.id} failed: ${error}`)),
            ),
          { discard: true },
        );
      });

    /**
     * Puts a finished branch into the operator's checkout.
     *
     * The only code path that writes there. No agent holds merge rights, reviewer
     * or author, so every branch passes the same clean-checkout and verification
     * gate however trivial the task that produced it was.
     */
    const land = (task: Item) =>
      Effect.gen(function* () {
        const project = projectFor(task.project);
        if (!project) return;

        const result = yield* repository.merge(
          project.directory,
          labelFor(task.id),
          project.verify,
        );
        if (result._tag === "Held") return;

        if (result._tag === "Rejected") {
          yield* Effect.logWarning(
            `landing ${task.id} (${project.name}) rejected: ${result.detail}`,
          );
          yield* prog.log(
            task.id,
            `foreman: finished branch could not be merged: ${result.detail}. Returned to the queue.`,
          );
          yield* climb(task);
          yield* prog.release(task.id);
          return yield* fleet.notify(
            "Landing failed",
            `${task.id} could not merge cleanly — back in the queue`,
          );
        }

        // The branch broke the project. The merge is already undone; what the
        // task needs is the output, because the next author's whole job is now
        // the failure below.
        if (result._tag === "Broke") {
          yield* Effect.logWarning(
            `landing ${task.id} broke ${project.name}'s verification; merge undone`,
          );
          yield* prog.log(
            task.id,
            `foreman: finished branch failed ${project.name}'s verification after merging, so the merge was undone and the task returned to the queue.\n\n${result.output}`,
          );
          yield* climb(task);
          yield* prog.release(task.id);
          return yield* fleet.notify(
            "Landing reverted",
            `${task.id} broke ${project.name} — back in the queue`,
          );
        }

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
        yield* prog.complete(task.id);
        yield* fleet.notify("Task landed", `${task.id} ${task.title}`);
        yield* teardown(task);
      }).pipe(Effect.catchAll((error) => Effect.logWarning(`landing ${task.id} failed: ${error}`)));

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
    const tidy = (current: Observation) =>
      Effect.forEach(
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
            Effect.catchAll((error) =>
              Effect.logWarning(`pruning ${entry.branch} in ${entry.project} failed: ${error}`),
            ),
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
              // Only a workspace that still exists is taken down. A worker
              // whose workspace already closed leaves its worktree behind on
              // purpose: it may hold the interrupted agent's edits, and the
              // next author opens onto them.
              if (worker) yield* teardown(task);
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
     * Tasks in a held project are passed over. Every branch eventually merges
     * into that checkout, so dispatching there would put its landing against
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
          // Work small enough to skip the reviewer is waiting to land, not
          // waiting to be read. Its project is held, or it would be gone.
          if (!needsReview(task)) continue;
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

        // The bottom rung by default; higher only where the rungs below have
        // already been tried and failed. The task carries that history in a
        // label, so it survives restarts and you can pin it by hand.
        const rung = authorFor(settings.ladder, rungOf(task));
        if (!rung) return;

        // The workspace opens before the claim. If it opened after, a task
        // would briefly be claimed with nothing to show for it, and that state
        // is indistinguishable from an abandoned claim.
        const worker = yield* fleet.open({
          task: task.id,
          repository: project.directory,
          branch: labelFor(task.id),
          directory: directoryFor(task.project, task.id),
        });

        const prompt = yield* prompts.author(task, worker.directory, project.directory);
        yield* prog.claim(task.id);
        yield* prog
          .attribute(task.id, rung.name)
          .pipe(Effect.tapError(() => prog.release(task.id)));
        const agent = yield* fleet.spawn(worker, spawnAs(rung, prompt, "author")).pipe(
          // The agent never started, so the claim would strand the task until
          // the stale sweep noticed. Hand it back immediately instead.
          Effect.tapError(() => prog.release(task.id)),
        );
        yield* prog.log(task.id, agentLog("author", rung, agent));
        yield* Effect.logInfo(
          `dispatched ${task.id} (${task.project}) to ${rung.name} in ${worker.workspace}`,
        );
      });

    const dispatchReview = (task: Item, author: string | undefined) =>
      Effect.gen(function* () {
        const project = projectFor(task.project);
        if (!project) return;

        const rung = reviewerFor(settings.ladder, author);
        const worker = yield* fleet.open({
          task: task.id,
          repository: project.directory,
          branch: labelFor(task.id),
          directory: directoryFor(task.project, task.id),
        });

        const prompt = yield* prompts.review(task, worker.directory, project.directory);
        yield* prog.assignReview(task.id, rung.name);
        const agent = yield* fleet
          .spawn(worker, spawnAs(rung, prompt, "review"))
          .pipe(Effect.tapError(() => prog.clearReview(task.id)));
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

    const dispatchOnboard = (task: Item, project: Project) =>
      Effect.gen(function* () {
        const rung = topOf(settings.ladder);

        // Attached, not a worktree: the work being rescued exists only in this
        // checkout, so a copy of the last commit would show the agent nothing.
        const worker = yield* fleet.attach({ task: task.id, repository: project.directory });
        const prompt = yield* prompts.onboard(task, project.directory);

        yield* prog.claim(task.id);
        yield* prog
          .attribute(task.id, rung.name)
          .pipe(Effect.tapError(() => prog.release(task.id)));
        const agent = yield* fleet
          .spawn(worker, spawnAs(rung, prompt, "author"))
          .pipe(Effect.tapError(() => prog.release(task.id)));
        yield* prog.log(task.id, agentLog("author", rung, agent));
        yield* Effect.logInfo(`onboarding ${project.name} as ${task.id} with ${rung.name}`);
      });

    /**
     * Moves a task one rung up the ladder, and says so when that rung is a
     * person.
     *
     * Every path that hands work back to the queue comes through here, so the
     * evidence that a rung failed is written where the next dispatch reads it
     * rather than being lost with the worker. Climbing off the top rung parks
     * the task in the operator's column: a task the best model could not finish
     * should stop, not cycle. Silence there would mean waiting forever, so it
     * is announced like any other worker that needs somebody.
     */
    const climb = (task: Climbing) =>
      Effect.gen(function* () {
        const next = above(settings.ladder, rungOf(task));
        yield* prog.setRung(task.id, next);
        if (next === HUMAN) {
          yield* prog.log(
            task.id,
            `foreman: every rung of the ladder has been tried on ${task.id}. It is yours now — write the decision into this task, then remove the \`rung-${HUMAN}\` label to put it back in the queue.`,
          );
          yield* fleet.notify("Needs a decision", `${task.id} ${task.title}`);
        }
      });

    /**
     * Moves a task one rung down the ladder, at the operator's word.
     *
     * The mirror of `climb`, and the correction for every way a rung gets
     * written without being earned — a bug, an OOM, an operator killing a run.
     * One step per press, writing the same `rung-*` label the ladder reads, so
     * the result is exactly what foreman itself would have written. Off the
     * bottom rung the label is removed: the ladder reads no label as the
     * bottom, so a redundant `rung-<bottom>` would never be written by hand.
     */
    const descend = (task: Climbing) =>
      Effect.gen(function* () {
        const next = below(settings.ladder, rungOf(task));
        if (next === undefined) return yield* prog.clearRung(task.id);
        yield* prog.setRung(task.id, next);
      });

    const projectFor = (name: string) =>
      settings.projects.find((candidate) => candidate.name === name);

    /** The checkout a project's work lands in, when foreman is configured for it. */
    const repositoryFor = (task: { readonly project: string }) =>
      projectFor(task.project)?.directory;

    /**
     * Takes down a task's workspace and, with it, the worktree foreman made.
     * `fleet.close` resolves the same way `open` does, so a workspace herdr has
     * already dropped still leaves its worktree removed rather than orphaned.
     */
    const teardown = (task: { readonly id: string; readonly project: string }) =>
      fleet.close({ task: task.id, repository: repositoryFor(task) });

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
          `foreman up: ${plural(settings.slots, "slot")} over ${plural(settings.projects.length, "project")}, polling every ${settings.pollInterval}s`,
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

      /** Stops filling slots. Live workers are left to finish. */
      pause: commanded(Ref.set(paused, true)),
      resume: commanded(Ref.set(paused, false)),

      /** Brings a task's workspace to the front so you can take over. */
      focus: (worker: Worker) => fleet.focus(worker),

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

      /** Starts a fresh agent on a task whose worker vanished. */
      retry: (task: Item) =>
        commanded(
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

            const project = projectFor(task.project);
            if (!project) return;
            const rung = authorFor(settings.ladder, rungOf(task));
            if (!rung) return;
            // The workspace may be gone — the pane that was its only one closed
            // by hand. `fleet.open` resolves to the worktree git still has, so
            // a retry re-adopts the same directory with its edits instead of
            // losing them.
            const worker = yield* fleet.open({
              task: task.id,
              repository: project.directory,
              branch: labelFor(task.id),
              directory: directoryFor(task.project, task.id),
            });
            const prompt = yield* prompts.author(task, worker.directory, project.directory);
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
       */
      close: (task: Item) => commanded(teardown(task)),

      /** Closes a queued task without creating a workspace or landing code. */
      complete: (task: ReadyTask, reason: string) =>
        commanded(prog.log(task.id, `foreman: marked done from queue: ${reason}`).pipe(Effect.andThen(prog.complete(task.id)))),

      /** Moves a task one rung up the ladder for its next dispatch. */
      climb: (task: Climbing) => commanded(climb(task)),

      /** Moves a task one rung down the ladder, correcting an unearned climb. */
      descend: (task: Climbing) => commanded(descend(task)),

      /**
       * Clears a review-by-* label no reviewer is behind, at the operator's
       * word.
       *
       * The world records whether a reviewer was dispatched, not whether that
       * reviewer is still alive, so only the operator can say the label is
       * stale — the dashboard offers this exactly where the workspace is gone
       * and the task is open. Liveness is the view's call; the label is
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
       * Puts a stranded branch back in front of a reviewer.
       *
       * Nobody can say from the outside whether abandoned commits are worth
       * keeping, and that judgement is exactly a review. The task returns to
       * `reviewing`, a reviewer reads the diff, and it either approves — which
       * lands the branch through the ordinary gate — or returns it with
       * findings. A branch whose task is gone is skipped: it has no id to
       * dispatch against, so it stays on the list until a person deals with it.
       */
      adopt: (orphan: Orphan) =>
        commanded(
          orphan.status === undefined
            ? Effect.void
            : prog.submit(orphan.task).pipe(
                Effect.andThen(
                  prog.log(
                    orphan.task,
                    `foreman: ${orphan.branch} holds commits ${orphan.project} never took, and nothing in the queue was going to bring them back. Sent for review to decide whether they are worth landing.`,
                  ),
                ),
                Effect.catchAll((error) =>
                  Effect.logWarning(`adopting ${orphan.task} failed: ${error}`),
                ),
              ),
        ),
    } as const;
  }),
}) {}

/**
 * A finished branch whose fate is landing rather than the ordinary settle path,
 * whatever its pane is doing.
 *
 * `reviewing` means the author stopped writing, not that an agent must read the
 * diff. Work small enough to skip the reviewer is landed straight from there, so
 * every branch reaches the operator's checkout through the same gate — the one
 * that re-reads the tree, merges, and verifies. An author that merged its own
 * work would be the one path around it.
 */
export const awaitingLanding = (task: Item): boolean =>
  task.status === "reviewing" && (isApproved(task) || !needsReview(task));

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
 * reviewing task with a review-by-* label and an empty workspace is a reviewer
 * that vanished mid-verdict; a workspace whose task is neither claimed nor
 * under review is residue — the task is unclaimed, so nobody owns the
 * workspace — and the only answer is to close it.
 *
 * Residue is surfaced rather than swept because dispatchAuthor opens a
 * workspace before it claims its task: the brief window a fresh workspace
 * spends on an open task is exactly what a sweep would race, and it closes
 * within the same tick, long before anyone reads the dashboard.
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
      reviewedBy(task) !== undefined && (worker === undefined || worker.state === "gone"),
  ),
  ...owned.filter(({ task }) => task.status !== "in_progress" && task.status !== "reviewing"),
];

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
 * the same read that finds stranded branches. Of its own, not merely of ones
 * the checkout lacks: a branch already merged — by foreman on an earlier tick,
 * or by hand — proves its author wrote something just as well, and reading that
 * as an empty branch sends finished work back to the queue.
 */
export const reviewable = (
  reviewing: ReadonlyArray<Active>,
  committed: ReadonlySet<string>,
): { readonly review: ReadonlyArray<Active>; readonly unbacked: ReadonlyArray<Active> } => {
  const authored = reviewing.filter(({ task }) => authoredBy(task) !== undefined);
  return {
    review: authored.filter(({ task }) => committed.has(task.id)),
    unbacked: authored.filter(({ task }) => !committed.has(task.id)),
  };
};

/**
 * The workspaces this daemon may act on, split out of a roster that shows
 * every daemon's.
 *
 * herdr lists every workspace labelled `foreman/*` whoever opened it, and the
 * label carries no ownership — two foremen against different configs are not
 * competing for the same slots. The config's project set is the only ownership
 * the world records, so a workspace belongs to this daemon exactly when its
 * task lives in a project the config manages. A workspace whose task the store
 * no longer has a project to scope by: as residue it must not eat a slot
 * nothing will ever free, so it is dropped here too.
 *
 * Plan workspaces are also excluded by their durable task label. The workspace
 * exists before its planner or tasker role does, and plan mode is a separate
 * synchronous process that the daemon must neither count nor settle.
 *
 * Both shapes come back from the same pass so they cannot disagree: `owned` is
 * what settle and the dashboard may touch, and `workers` is the roster shape
 * slots are counted from.
 */
export const scopeRoster = (
  roster: ReadonlyArray<Worker>,
  tasks: ReadonlyMap<string, Item>,
  managed: ReadonlySet<string>,
): { readonly owned: ReadonlyArray<Owned>; readonly workers: ReadonlyArray<Worker> } => {
  const owned: Array<Owned> = [];
  const kept = new Set<string>();
  for (const worker of roster) {
    const task = tasks.get(worker.task);
    if (!task || !managed.has(task.project) || isPlan(task)) continue;
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
  prompt,
  role,
});

/** Everything the dashboard draws, and everything the loop decided from. */
export interface FleetState {
  readonly queue: ReadonlyArray<ReadyTask>;

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

  /**
   * Branches holding commits the project never took, that nothing in the
   * pipeline is going to bring back on its own.
   */
  readonly orphans: ReadonlyArray<Orphan>;

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

/**
 * Work git still has and prog has stopped tracking.
 *
 * `title` and `status` are absent when the task itself is gone. Such a branch
 * can be shown but not recovered: every workspace, prompt and merge in foreman
 * is addressed by task id, so there is nothing left to dispatch against.
 */
export interface Orphan {
  readonly project: string;
  readonly branch: string;
  readonly task: string;
  readonly title: string | undefined;
  readonly status: string | undefined;
}

/** A task and the workspace running it, if the multiplexer still has one. */
export interface Active {
  readonly task: Item;
  readonly worker: Worker | undefined;
  readonly kind: string | undefined;
}

export interface Owned {
  readonly task: Item;
  readonly worker: Worker;
  readonly kind: string | undefined;
}

interface Observation extends FleetState {
  readonly workers: ReadonlyArray<Worker>;
  readonly owned: ReadonlyArray<Owned>;

  /**
   * Tasks handed back for review whose branch holds no commits.
   *
   * Not part of `FleetState`: settle returns each of these to the queue on the
   * same tick that finds it, so it is a step's input rather than anything the
   * dashboard could draw.
   */
  readonly unbacked: ReadonlyArray<Active>;

  /**
   * Tasks whose branch carries commits of its own, landed or not.
   *
   * Also a step's input rather than a column: settle asks it whether a worker
   * that vanished got anything as far as a commit.
   */
  readonly committed: ReadonlySet<string>;

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
  queue: [],
  yours: [],
  working: [],
  review: [],
  landed: [],
  decisions: [],
  orphans: [],
  held: [],
  paused: false,
};

interface Project {
  readonly name: string;
  readonly directory: string;
}
