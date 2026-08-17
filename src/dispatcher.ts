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
import { Repository, RepositoryError } from "./repository.ts";
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
  diagnosticIntent,
  type DiagnosticIntent,
  isApproved,
  isOnboarding,
  isPlan,
  type Item,
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

      const mode = yield* Ref.get(dispatch);
      if (mode === "paused") return;
      yield* settle(current);
      yield* tidy(current);
      yield* reclaim(current);
      yield* recover(current);
      yield* fill(yield* observe, mode);
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

      // Work at the operator's rung is ready by every measure prog knows and
      // still must not be dispatched: it is waiting on a decision no agent can
      // make. Split here rather than in fill, so the dashboard can say where it
      // went instead of leaving it to look like a queue that stopped moving.
      const dispatchable = queue.filter((task) => !isYours(settings.ladder, rungOf(task)));
      const failed = failedTasks(yield* Ref.get(dispatchFailures));
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
        workers,
        owned,
        held,
        // Salvage runs stand in a directory a person is using, so they start
        // when that person asks and never because a slot came free.
        queue: interleave(
          excludeFailedTasks(
            dispatchable.filter((task) => !isOnboarding(task)),
            failed,
          ),
          settings.projects.map((project) => project.name),
        ),
        yours: queue.filter(
          (task) => isYours(settings.ladder, rungOf(task)) && managed.has(task.project),
        ),
        working: claimedActive,
        ...reviewable(reviewingActive, committed),
        committed,
        resumable,
        prunable,
        unreviewed,
        landed: landed.filter((item) =>
          DateTime.greaterThan(DateTime.unsafeFromDate(item.last_activity_at), landedWindow),
        ),
        decisions: [
          // A task whose dispatch failed is that decision, not whatever its
          // leftover workspace or label would name it — so it is filtered out
          // of the ordinary kinds rather than shown twice.
          ...decisionsOf(claimedActive, reviewingActive, owned).filter(
            (decision) => !failedIds.has(decision.task.id),
          ),
          ...failedDecisions,
        ],
        dispatch: yield* Ref.get(dispatch),
        observedAt: yield* DateTime.now,
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
              Effect.catchAll((error) =>
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
                yield* stopAgents(worker);
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
                //
                // Its pane stays open. The reviewer sends mechanical findings
                // back to the session that wrote the code rather than paying a
                // rung climb for a missed case, and that session only exists
                // while its pane does. Ownership passes with it: the reviewer
                // closes the author, and this is only the backstop for a task
                // no reviewer reached inside the window. The handoff is the
                // last activity on it, so the wait is derivable and foreman
                // still counts nothing.
                if (!reviewer) {
                  return handoffExpired(task, coachCutoff) ? yield* stopAgents(worker) : undefined;
                }

                yield* prog.log(
                  task.id,
                  `foreman: reviewer ${reviewer} stopped without a verdict. Returned to the queue one rung up.`,
                );
                yield* climb(task);
                yield* prog.release(task.id);
                yield* stopAgents(worker);
                return yield* fleet.notify(
                  "Review returned",
                  `${task.id} reviewer stopped without a verdict — back in the queue`,
                );
              }

              // Residue: the task is neither claimed nor under review, so no
              // agent is coming back to these panes. A role is what proves the
              // claim happened and was given up, since dispatch opens the
              // workspace before claiming and only labels the pane when it
              // spawns — so a workspace carrying none may be a dispatch in
              // flight and is left for `decisionsOf`. Panes only: the worktree
              // and anything uncommitted in it survive for `Fleet.open`.
              if (task.status !== "in_progress") {
                return yield* Effect.forEach(
                  [...worker.roles.keys()],
                  (role) => fleet.stop(worker, role),
                  { discard: true },
                );
              }

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
     * gate.
     */
    const land = (task: Item, worker: Worker | undefined) =>
      Effect.gen(function* () {
        const project = projectFor(task.project);
        if (!project) return;

        const result = yield* repository.merge(
          project.directory,
          labelFor(task.id),
          project.verify,
        );
        // The verdict is a durable label, so a later tick lands from it with no
        // pane at all — and a project can stay dirty for hours.
        if (result._tag === "Held") {
          // An operator editing clears itself and is not worth a line every
          // poll. A detail means git or jj could not run the merge at all,
          // which never clears and must not retry in silence.
          if (result.detail) {
            yield* Effect.logWarning(`landing ${task.id} (${project.name}) held: ${result.detail}`);
          }
          return yield* stopAgents(worker);
        }

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

        // Both remaining verdicts end the task, and differ only in what foreman
        // may honestly say it did. `Present` wrote nothing and ran nothing, so
        // it claims neither a merge nor a verification; it exists to close the
        // task an interrupted landing left open after its merge had gone in.
        if (result._tag === "Present") {
          yield* Effect.logInfo(
            `${task.id} (${project.name}) was already in the checkout; completing`,
          );
          yield* prog.log(
            task.id,
            `foreman: ${project.name}'s checkout already contained this branch, so there was nothing to merge. An earlier landing put the commits in without reaching this step.`,
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
              Effect.catchAll((error) =>
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
              Effect.catchAll((error) =>
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
    const recover = (current: Observation) =>
      Effect.gen(function* () {
        const oldest = current.unreviewed.find(recoverable);
        if (!oldest) return;
        yield* prog.submit(oldest.task);
        yield* prog.log(
          oldest.task,
          `foreman: ${oldest.task} is done, but ${oldest.branch} still holds commits ${oldest.project} never took, so the landing never completed. Nothing in the pipeline reaches a done task, so it is back in review to decide whether the work is worth landing.`,
        );
        yield* Effect.logInfo(`recovered ${oldest.task} (${oldest.project}) for review`);
      }).pipe(
        Effect.catchAll((error) => Effect.logWarning(`recovering a branch failed: ${error}`)),
      );

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
    const fill = (current: Observation, mode: Dispatch) =>
      Effect.gen(function* () {
        const busy = current.workers.filter(
          (worker) => worker.state === "working" || worker.state === "blocked",
        ).length;
        let free = settings.slots - busy;
        if (free <= 0) return;

        // A task whose dispatch has failed twice is held out of both passes.
        // Its failure is a fact about the world, so a third attempt would
        // repeat the second; the operator clears the cause and retries.
        const failed = new Set(failedTasks(yield* Ref.get(dispatchFailures)).map(([task]) => task));

        for (const { task, worker } of current.review) {
          if (free <= 0) return;
          if (current.held.includes(task.project)) continue;
          if (reviewedBy(task) !== undefined) continue;
          if (worker && (worker.state === "working" || worker.state === "blocked")) continue;
          if (failed.has(task.id)) continue;
          yield* dispatchReview(task, authoredBy(task)).pipe(
            Effect.tap(() => clearFailure(task.id)),
            Effect.catchAll((error) => recordFailure(task.id, error)),
          );
          free -= 1;
        }

        // Draining is exactly this pass being skipped. Everything above it
        // has already run, so the fleet keeps finishing and landing what it
        // holds and simply stops taking anything on.
        if (mode === "draining") return;

        const available = current.queue.filter(
          (task) => !current.held.includes(task.project) && !failed.has(task.id),
        );
        for (const task of available.slice(0, free)) {
          yield* dispatchAuthor(task).pipe(
            Effect.tap(() => clearFailure(task.id)),
            Effect.catchAll((error) => recordFailure(task.id, error)),
          );
        }
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
        const worker = yield* workspaceFor(task, project);

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

        const rung = reviewerFor(settings.ladder, author);
        const worker = yield* workspaceFor(task, project);

        const prompt = yield* prompts.review(
          task,
          worker.directory,
          project.directory,
          base,
          project.verify,
        );
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
     * herdr cannot end an agent without closing its pane, so a settled agent
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
          const agent = yield* fleet.spawn(worker, spawnAs(rung, prompt, "author"));
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
        yield* prog.setRung(task.id, rung.name);
        yield* dispatchAuthor(yield* prog.show(task.id));
      });

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
      rungs: settings.ladder.map((rung) => rung.name),

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

      /**
       * States how much work the fleet may take on. Live workers are never
       * interrupted by it; narrowing only stops the next dispatch.
       */
      setDispatch: (mode: Dispatch) => commanded(Ref.set(dispatch, mode)),

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
                    Effect.catchAll((error) => recordFailure(task.id, error)),
                  );
                }
                return;
              }
              if (task.status === "reviewing") {
                return yield* dispatchReview(task, authoredBy(task)).pipe(
                  Effect.catchAll((error) => recordFailure(task.id, error)),
                );
              }
              return yield* dispatchAuthor(task).pipe(
                Effect.catchAll((error) => recordFailure(task.id, error)),
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
            const rung = authorFor(settings.ladder, rungOf(task));
            if (!rung) return;
            // The workspace may be gone — the pane that was its only one closed
            // by hand. `fleet.open` resolves to the worktree git still has, so
            // a retry re-adopts the same directory with its edits instead of
            // losing them.
            const worker = yield* workspaceFor(task, project);
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
                Effect.catchAll((error) =>
                  Effect.logWarning(`adopting ${branch.task} failed: ${error}`),
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
  DateTime.lessThan(DateTime.unsafeFromDate(task.last_activity_at), cutoff);

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
  readonly committed: ReadonlySet<string>;
  readonly resumable: ReadonlySet<string>;

  /**
   * Branches holding commits the project never took, that no reviewer is
   * going to read on its own.
   */
  readonly unreviewed: ReadonlyArray<Unreviewed>;

  /**
   * Projects whose checkout has uncommitted changes to tracked files.
   *
   * The operator is working there, so their tasks stay in the queue until the
   * tree is clean again. Naming them is the point: a queue that stops moving
   * for a reason nobody can see reads as a broken dispatcher.
   */
  readonly held: ReadonlyArray<string>;
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

/** A task and the workspace running it, if the multiplexer still has one. */
export interface Active {
  readonly task: Item;
  readonly worker: Worker | undefined;
  readonly kind: string | undefined;
  /** The error behind a dispatch-failed decision, absent for the other kinds. */
  readonly failure?: string;
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
  committed: new Set(),
  resumable: new Set(),
  unreviewed: [],
  held: [],
  // Before the first tick has read anything, and the state foreman starts in
  // unless the command line said otherwise.
  dispatch: "paused",
  observedAt: undefined,
};

interface Project {
  readonly name: string;
  readonly directory: string;
}
