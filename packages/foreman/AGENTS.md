# Working on foreman

The README says what foreman does. This says why it is shaped the way it is, and
which walls are already known so you do not walk into them again.

Keep it that way. This file is loaded into every session and read by every agent
the fleet dispatches, so its length is a cost paid on every turn. Record the
constraint and the reason it exists — never the incident that revealed it. No
dates, no task ids as evidence, no counts, no proof-run narration.

## Status

The tree is one `Dispatcher` service over `Fleet`, `Tracker`, `Records` and `Repository`. It
runs in one place: `foreman serve` (`src/serve.ts`) builds it through
`src/host.ts` (`buildHost`), supervised, and restarts it after a failure. A
lock beside `state.json` keeps a second serve from starting. A systemd user
unit (`systemd/foreman.service`) starts serve at login. Every other command in
`src/main.ts` is one-shot.

Proven live: the author → review → merge pipeline end to end. The rig is in
`e2e/` — read `e2e/README.md` before running it.

- **The quota gate is unproven inside a tick.** Both probes are proven live
  through `foreman quota`, and the pass-over is proven by unit tests, but no
  dispatcher has yet declined to dispatch because of one. Watch a run at
  `foreman policy slots 1` against a spent account before trusting it to hold
  the fleet.

## The design, and why

### The world holds the work, the operator's files hold the intention

The world is authoritative for the state of the work, not the process. A
dispatcher whose memory is authoritative loses the fleet on every restart: tasks
stay claimed, agents keep running, and nothing can tell foreman's own work from
a claim made by hand.

| Question                          | Answered by                                                                                                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What am I working on?             | the worktree git has registered for `foreman/<task-id>`                                                                                                                                                                                |
| Who authored this branch?         | the rung of the task's latest author run                                                                                                                                                                                               |
| Is a reviewer assigned?           | an open review run in the task's current lap                                                                                                                                                                                           |
| Where is this task?               | where the exit its last run named leads in the drawing, looked up by the exit's id, while the tip is the commit that exit was named on; a decision for the operator when the drawing lacks that exit                                   |
| Has a reviewer accepted it?       | its last exit is `approved`, and the tip is the commit it was named on                                                                                                                                                                 |
| Which rung comes next?            | from the lowest level above every level with a rung charged with failing the task, the configured, enabled, author-on, funded rung that started a run least recently, off the accounts its runs ended `walled` on since it last landed |
| Which reviewer reads it?          | from the reviewers its review block draws, the one that started a review least recently, off a spent account and off every reviewer that stopped this lap with no verdict, preferring a model other than the author's                  |
| How many tries has this rung had? | its author runs on the rung that ended `stopped` or `vanished` since the rung's last charge                                                                                                                                            |
| Is this one waiting on a person?  | every configured rung has failed it, or it has a park                                                                                                                                                                                  |
| Is this task mine to review?      | it has an author run                                                                                                                                                                                                                   |
| Is this worker mine?              | the checkout in its terminals' `fm.repo` label                                                                                                                                                                                         |
| Which projects are in play?       | the git checkouts of the operator's open herdr-app spaces                                                                                                                                                                              |
| Is this project free to work in?  | `git` in its checkout                                                                                                                                                                                                                  |

Every tick reads all of it back, so a restart re-adopts its live workers
instead of orphaning them.

The policy file (`src/policy.ts`), the pipelines file (`src/pipeline-file.ts`),
the drafts file beside it (`src/pipeline-draft.ts`) and the instructions files
in `prompts/` beside them (`src/prompt.ts`)
are the only durable things foreman holds, because nothing in the world records
the operator's intention. The policy holds `paused`,
`slots`, a default for each spending step (`author`, `climb`, `review`, `publish`, `land`)
(`on` runs it, `ask` holds it for one approval per task, `off` does nothing),
grants that widen the default for one task or epic, and `projects`: a
project's own `paused`, its own mode for any step, which replace the
default for that project's tasks only, and its `schedules` (recurring
patterns filed from a template on a cadence). A paused project takes no step, grants included; slots stay
fleet-wide, and an agent block's `slots` caps that block's running tasks inside
them. `foreman policy`, `foreman schedule` and the Foreman pane write it
through `updatePolicy`. The dispatcher reads it every pass, and
writes only which tasks each grant admitted and which grants expired, so a
grant's count survives a restart. It is a file, not process state, because a
restart of the host is not an operator. The dispatcher also watches the file
and publishes a change at once, outside the tick, because a tick can take
seconds and the operator's click should show in the reading before it ends.
The pipelines file holds each project's pipeline (`docs/pipeline-engine.md`); it
sits in the policy file's directory, and both are written through `rewrite` in
`src/shared-file.ts`. The drafts file (`pipelines.draft.json`, beside it) holds
the pipeline the operator is still drawing for a project, with the drawn
pipeline the draft began from. The files are `{ pipelines, composites }` and `{ drafts, composites }`:
the composite definitions sit beside the pipelines, and definition drafts beside
the project drafts (`docs/composite-blocks.md`). A pipelines file that does not
decode stops every project. A definition that decodes but fails expansion or
validation stops only the projects that use it. A draft may not run yet, so the
dispatcher never reads it. `foreman pipeline edit` changes it one `PipelineChange`
(`src/pipeline-edit.ts`) at a time, and `foreman pipeline save` checks it and
writes it through the same `runPipeline` as `set`, refusing when the drawn
pipeline changed since the draft began. `foreman pipeline trace` reads the
draft, else the drawn pipeline, else the standard one, and writes nothing.
`foreman pipeline simulate` reads the draft and the pipeline the project runs,
and writes nothing.
`foreman pipeline prompt` renders an agent block of the draft, else of the
drawn pipeline, else of the standard one, for a pretend task, and writes nothing.
`foreman pipeline instructions` prints an instructions file, or writes the
operator's copy in `prompts/`, which the next dispatch reads.

`modeOf` in `src/policy.ts` reads three states out of it. `paused` is the
operator's stop; `idle` is every step off and no grant; `running` is anything
else (a step on by default or for any unpaused project, or a grant), so an
`ask` step runs the fleet: it must read the world to find what to ask about.
Only a running tick acts: a paused or idle tick reads the world and publishes
the reading, and writes nothing to the task store, git, hc or the policy file — settle,
tidy, reclaim and recover wait too. Stopping the fleet must hold the world still
while the operator looks at it. To empty the pipeline without taking on new
work, turn `author` and `climb` off and leave `review` and `land` on.

An ask is a reading, not a record. `dispatchFrom` plans each tick's dispatches,
landings, parks and asks together, from where each task stands in its project's
pipeline. A slot is spent when a step runs, not when it is asked about,
so an ask holds no slot: review, climb and land asks are listed whatever the free
count and never hold back a granted task behind them. Author asks are capped at
`slots`, so an `ask` author step does not list the whole queue. An approved step
waits for a free slot like any dispatch. `foreman approve <id>`
answers one with an ordinary one-task grant for the asked step, which the next
tick takes; nothing else stores approvals. `foreman wait --asks` returns when a
new ask appears, for a coordinator that answers asks while it talks to the operator.

A grant permits a step. It never reorders the queue: the plan takes tasks with
the fewest work blocks left first, then in queue order, and passes over each task
that a gate on its route does not permit. Which granted tasks may run
at once is what `tasks ready` returns, so the plan's blockers decide it, and
restating that here would be a second, weaker copy of the dependency graph.

Foreman keeps one thing in process, in a `Ref`: how a dispatch attempt failed,
which is an event of foreman's own doing. A dispatch failure is observed by trying, and the trying is what must stop: the
worktree that made `open` fail will still exist next tick, so a retry learns
nothing. Two identical failures for a task stop it being offered and surface it
as a decision with the error on the row. The tally is in-process, not durable —
a restart forgets it and costs two attempts to relearn — because the count is a
property of foreman's attempts, not of the task, and the task store has no
place for it. The tasks themselves stay safe in the queue either way.
`nextFailure` in `src/dispatcher.ts` is the pure counting; `recordFailure`
writes the one log line per failure instead of one per tick.

The wake queue beside it holds no state: it only ends the poll wait early, after
`commanded` in the dispatcher's own process. A one-shot command in another
process does not wake it: the dispatcher reads its change on the next poll.

**Durable state beyond the policy, pipelines, drafts and instructions files and
foreman's own records is a wall.** Foreman's own records are what it writes about its
runs, in its database beside the task store and keyed by task id: the runs, the
charges (a rung charged with failing a task) and the parks (a task waiting for
the operator), so a tracker carries only task state. Needing any other state
means something the world should record is not being recorded, and the fix
belongs in hc, herdr-app or the tracker.

### Projects are the open spaces

The config lists no projects. A project is the git checkout an open herdr-app
space sits in, named by the checkout's folder, which is also its tasks project
(`src/projects.ts`). Only an open project takes new work; the managed set adds
every checkout a foreman agent still runs in, so closing a space drains the work
under way. When a project leaves both sets while authored tasks are still
mid-pipeline, attention shows one stranded row for that project — surface,
don't finish; reopening a space resumes the pipeline. Two checkouts with one
name are held as `ambiguous`, because a task names a project, not a directory. A project's verify command is its own
`scripts/verify.sh`, and its preview command is its own `scripts/preview.sh`:
`foreman preview <task>` runs it in a task's worktree, in the hc terminal
`preview-<task>`, which carries no fleet label, so the roster never reads it as
an agent.

### One workspace per task

The task's route says where it works (see "Workspace blocks" below): the
operator's checkout by default, or a worktree of its own when the project draws
the `worktree` choice with `foreman pipeline use`.

`foreman/<task-id>` is the git branch. Each of the task's agents runs in an hc
terminal labelled with the task (`fm.task`) and its role (`fm.role`), in
`src/hc.ts`. The branch is the durable identity other processes read.

The worktree, not the terminals, is where the work lives. Terminals come and go,
and a person can close one, while the worktree and branch survive. `Fleet.open`
therefore resolves in order: a worker already running for the task, else a
worktree git still has registered for the branch, else creating both. Teardown
reads git's record of the branch too, so a worktree whose agents already ended is
removed rather than orphaned.

The roster is every foreman terminal on the hc server. `ours` in
`src/dispatcher.ts` keeps the workers whose `fm.repo` checkout is a managed
project, so ownership is settled before the store is asked anything.

The checkout, not the task's project. The task's project answers the same
question right up until the task is deleted — which is exactly when ownership
needs an answer — and asking it means one `tasks show` per worker on the
machine before knowing whether any of them is this dispatcher's. A worker with
no `fm.repo` checkout has nothing to be scoped by and is nobody's.

What survives that scope and the store then denies is an **orphan**: a
worker whose task was deleted under it. No column shows it, no slot counts
it and no tick will dispatch into it, so it is surfaced in attention with one
action, `close`. Not swept, because the worktree may hold uncommitted work and no
task remains to say what it was. This is why `Records.lookup` answers `Option`
rather than failing: "there is no such task" is a fact about the world, while a
store that would not answer says nothing at all and must leave the worker
alone. `Records.show` is `lookup` with the absent case made an error, for the
callers that already know the task exists.

### A vanished worker is not a verdict

A role is `gone` when its terminal has exited, or when the live terminal runs a
program other than the one foreman started: herdr-app puts a shell in place of
an agent killed by a signal (`stateOf` in `src/hc.ts`). That covers an agent
that exited cleanly **and** one a human closed to take over, and nothing tells
them apart, so foreman does not try. Treating it as failure means closing an
agent to stop a run spends money on the next rung.

A vanished worker becomes a **decision** in `FleetState`, surfaced in
attention, and the task stays claimed until someone answers. After
`staleAfterHours` of no activity the claim is released with a log line — only a
claim foreman's own agent made, which its author run records. A claim made by
hand or by another session is its owner's to give up: foreman cannot tell an
abandoned one from one whose owner is away.

A lost exit is a decision too. A run stores the id of the exit it named, and a
rename changes only the name, so a rename leaves the task where it was. When
the drawing lacks the stored exit, or its block, the run says where the
task went and the drawing cannot say where that leads now. Placing the task
from its source would read the gap as evidence that the work must start over.
So placement answers `ExitGone`, and the task is published in attention with
the reason and the answers `release` and `intervene`. Nothing reclaims it, and
it holds its claim until the operator answers.

Absence is an unknown, not evidence. A task climbs a rung on real evidence only:
a reviewer sending work back, a branch that broke the project's verification, or
a level spent by `attemptsPerLevel` `stopped` endings. A branch that merely would
not **merge** is none of them: every author cuts from the trunk's tip, so a
branch whose tip has not moved fast-forwards and cannot conflict — a conflict
therefore means the trunk moved afterwards, which no model is stronger at
avoiding. It returns to the queue at the same rung, with the conflicting paths
on its log, and the ordinary attempt count still bounds a task that cannot
get past it. An agent that merely stopped without
finishing has said nothing about its model — a crash and a timeout end the same
way — so the task stays at the level and is tried again, on the peer whose turn
it is. The count of those endings is the task's runs on any rung of the level
that ended `stopped` or `vanished` since the last charge on one of them
(`attemptsOf` over `levelPeers`), so a dispatch days later reads the same
number, and a level of several peers is not tried more often than a level of
one.

An agent whose pane is idle without an exit is not stopped until it has sat
idle for `stallGraceMinutes` (default 5), counted from the time hc reports
for its last turn (`status_ms`). An interrupted turn, a harness that stopped
mid-task and an agent that forgot its exit all look like this, and the window
lets the operator steer the pane by hand: typing starts a new turn, which
resets the count. Past the window foreman stops the pane and keeps the
worktree when it holds work, so the next author is told to continue from it,
as after a vanished pane; only an empty worktree is removed. A harness that
reports no status (cursor-agent) reads as working and never reaches this.

A usage wall is the one stop that says something, and it says it about the
account, not the model. Each harness's wall text is listed in `src/harness.ts`,
read from the screen of the stopped author, and matched only at the foot of it.
The run ends `walled`, which is no attempt and no charge, and the next author
skips that account (`walledBy`). Landing the task ends the wall.

### The operator's checkout is shared, so it is asked about

Every task with a local landing ends by landing on its target, the branch its
land's `onto` names, else the branch the project's main checkout has out, and a
direct task commits there from the start: the checkout is the one the operator
edits in. A pull-request landing merges into the target on the remote instead, and the
operator's checkout takes it by its own pull. `Repository.isFree` is the dispatch gate: a project it answers `Held`
for is **held**, and `fill` passes over its tasks in both the review and the
author pass. It is read every tick, so a project frees itself the moment the
cause clears.

The held state carries the reason, not just the name. `isFree` returns a
`Clean`/`Held` verdict (`Hold`) whose `detail` names which of the causes holds
the project: a detached HEAD, a checkout foreman cannot read (the dispatcher's
catch, not the probe's), or an `ambiguous` name. The landing gates return the same
verdict, so the dispatch gate and the landing
never disagree about why a checkout is busy. The held row shows it, and it is
what the operator reads to tell a hold that clears itself from one that never
does.

Under git, uncommitted work holds only the landings that write the same paths,
untracked files included, because a fast-forward refuses to overwrite either.
`merge` asks that per branch, before the proof and again after a refused
fast-forward. Holding the whole project on any edit would stop the fleet for as
long as the operator works.

A checkout with no branch is held: a branch cut there would record no target,
and `git merge` into a detached `HEAD` succeeds while the operator's branch stays
put. "Free to work against" means there is a branch for the
work to land on.

A target is fixed when the task's branch is cut: the branch block records it as
the branch's git upstream, and the landing, the pull request's base, the
reviewer's base and the sweep all read that upstream, so a drawing edit applies
only to branches cut after it. With no `onto` the branch records the branch the
checkout has out. A branch with no upstream has no target and no fallback: its
landing holds (`noBranch`, naming the branch), and the sweep reads it as work.
A target the checkout has out is fast-forwarded
there. A target out nowhere is moved by a compare-and-swap of its ref
(`update-ref <ref> <proved> <old tip>`), which writes no file, so no dirty path
holds it. A target that does not exist holds the project (`noBranch`, naming it),
at dispatch and at landing.

An unreadable repository counts as held — foreman cannot merge into a checkout it
cannot read either.

The dispatch gate cannot be the only gate, because a tree can go dirty in the
hours between an agent starting and its branch being ready. `Repository.merge`
asks the same question again before it proves anything (only the already-merged
check below comes first) and returns `Held`: the landing is not attempted, the
`approved` exit stays on the run, and a later tick lands it. No prompt is involved,
because no agent merges.

In a worktree, agents stay out of that checkout entirely. `git` commands there refresh the
index, which collides with a landing mid-merge and leaves `index.lock` behind;
foreman's own reads set `GIT_OPTIONAL_LOCKS=0`, and an agent's cannot be made to.
`Repository.base` resolves a branch's fork point so a reviewer can diff
`<base>..HEAD` inside its own worktree. A route with no worktree and onboarding
are the exceptions, and in each the project is held for everything else while
the agent is there.

### Workspace blocks: where a task works

The pipeline says where a task works, not the policy (`docs/workspace-blocks.md`).
A `branch` block makes `foreman/<id>` from the tip of its target; a `worktree` block puts
it in a directory of its own. `routeWorkspace` reads the shape off the task's
route, and `workspaceFor` opens it: a worktree, the operator's checkout on the
task's branch (branch only), or the operator's checkout on the operator's own
branch (direct, no branch). Both blocks are walked through like gates, and git
records whether they are passed, so tasks in flight place as before.

- **Every route from a branch reaches a land or a park.** Validation refuses a
  branch that reaches `done`, a worktree or land with no branch before it, and a
  workspace block after an agent or a check: the workspace is set before the
  first agent.
- **A branch lands on one target.** Every land a branch block reaches names the
  same `onto`, absent counting as one target (the checkout's branch), or
  validation names the lands. A direct route has no land and stays on the
  operator's branch.
- **The checkout holds one task at a time.** A task holds it while its commits
  sit there: a branch task while git has its branch out in the checkout, a
  direct task from its first author run there (the run's `base`) until it leaves
  the pipeline. Either shows as a `busy` hold that names the task. Author runs
  alone are no evidence: a task whose authors worked in a worktree, or whose
  branch is absent from the checkout, holds nothing. The hold covers every other task in the
  project, landings included. A dispatch the
  planner sends into a free checkout takes it in the same pass, and needs a clean
  tree (`Repository.dirty`), because git carries uncommitted edits into the
  agent's commits. That dirty tree is not a held row: a row would hold
  the project's worktree tasks too, which uncommitted work must not do.
- **Branch-only routes use checkout git operations.** `Fleet.open` with the
  checkout as the directory runs `Repository.checkoutBranch`, which sets the
  branch it left as the upstream; `trunkOf` reads that upstream as the trunk while
  the task branch is out; landing and teardown (`leaveBranch`) check the
  upstream out again from a clean tree. The checkout is never removed. So the
  upstream is both the target and the branch the checkout returns to: a route
  whose `onto` the checkout does not have out holds the project, with a row that
  names both branches, and foreman never moves the checkout to a branch the
  operator was not on.
- **Direct has no undo, and completes at `done`.** The author commits onto the
  operator's branch, so a rejection is fixed by new commits. Each direct author
  run records the checkout's HEAD as its `base`; the reviewer reads from the first
  one, the task's tip is the checkout's HEAD while it occupies it, and a tip past
  the base is the author's commit. `done` completes the task and merges nothing.
- **`land` has `how`.** `merge` (the default) makes a merge commit;
  `fast-forward` lands only a commit that descends from the target's tip, and a
  target that moved returns the task like a conflict. Foreman never rebases: a
  rebase makes a commit the reviewer did not read. `pull-request` needs a
  publish gate besides its land gate, so a change of `how` brings or takes out
  the publish gate in the same edit, and `foreman pipeline use --land
pull-request` draws it.

### Onboarding salvages the operator's checkout

A held project is unheld by salvaging what is in it. `Dispatcher.onboard` files a
task in that project, calls `Fleet.attach` for a worker on the checkout
itself, and runs `prompts/onboard.md` at the top rung. Reading abandoned work and
inferring what somebody meant is the judgement cheap models are worst at, and
this runs once per project rather than once per task.

The `onboard` action is offered only for a `dirty` hold, the one cause salvage
addresses. A checkout held for a missing landing target has a clean
tree, so the offer would spend the run discovering nothing is there; the held
row says what to fix instead.

- **`Fleet.attach`, not `Fleet.open`.** The work exists only in that checkout. A
  worktree would hand the agent a copy of the last commit — the one state that
  contains none of what it was sent to find.
- **`Worker.worktree` decides teardown.** It is set only when the worker's
  directory differs from its `fm.repo` checkout, read back from the terminals
  every tick, and `close` removes nothing for a worker whose `worktree` is
  unset. So an attached worker's directory stays the operator's. Deriving it from
  foreman's memory is how you eventually delete somebody's work.
- **The `onboard` label keeps it out of the queue.** The queue is work the fleet
  may start by itself, and this stands in a directory a person is using. The
  label survives a failed attempt, and `retry` routes it back through
  `dispatchOnboard` rather than sending an author into a worktree.

The prompt forbids `stash`, `reset`, `checkout -- <file>` and `clean` by name,
and ends by returning the operator's branch to its previous tip. Read it before
changing anything about this path.

### Foreman does the deterministic part

Where a step has one right answer, foreman runs it. Where it needs judgement, the
answer is to make dispatching an agent easy — not to make foreman guess. A step
with one right answer, written as prose in a prompt, is the worst of both: it
costs tokens every dispatch, a cheap model can skip it, and the failure it causes
gets charged to the task rather than to the setup.

`scripts/worktree-setup.sh` is that split made concrete. A worktree does not
share the checkout's installed dependencies, so `workspaceFor` runs the script
before every dispatch and refuses to hand over a worktree whose setup failed —
that failure is the project's or the machine's, never the task's.

- **The project records the command, not the config.** A checked-in script is a
  fact about the project foreman reads back like every other, and a project that
  gains one is picked up with no config edit. Absent is a valid answer.
- **It runs before every dispatch**, not only into a worktree foreman just made,
  because nothing in the world says "this directory is already set up" and
  foreman does not remember it. So the script must be safe to re-run — which a
  package manager's install already is, and which a clone needs a guard to
  become. Re-running is also what repairs a half-written worktree.
- **The prompts close the loop.** An agent that repairs a worktree by hand is
  told to add the missing step to the script and commit it. That is the ratchet:
  every hand repair converts one non-deterministic step into a deterministic one,
  and the next agent arrives in a worktree that already builds instead of solving
  the same puzzle on its own task's budget.

### Order inside a tick

Settle (it lands, then runs checks), tidy, reclaim, recover, fire schedules,
then fill — and **the work nearest the end is filled first**: the fewest
work blocks left, then queue order. In the standard pipeline that is landings,
then reviews, then new work. A task
awaiting review is nearly finished and is blocking whatever depends on it,
whereas an unclaimed task has not started costing anything. Filling slots with
new work while reviews pile up grows a permanent tail of almost-done tasks.

### Schedules

A schedule is the operator's intention to repeat a pattern: it lives in the
policy file under `projects.<project>.schedules` as
`{ name, every, title, labels, template }`, and files a task from a template
on a cadence. Foreman holds no code for any one pattern — a pattern such as a
retro is a schedule plus a template. `every` is a tagged union; the one kind
now is `{ landed: N }`. Both `title` and `template` render `{{ project }}` and
`{{ since }}`; the template is an instructions file in `prompts/`, read through
`src/prompt.ts` so the operator's copy wins.

Firing reads the world each running tick, after settle: for each managed
project and each of its schedules, `since` is the creation time of the newest
task labeled `schedule:<name>`, else the start of time. The count is the
distinct tasks whose author run closed `committed` or `answered` at or after
`since`, leaving out the schedule's own filings. When the count reaches N and
no task labeled `schedule:<name>` is open or in progress, one task is filed
with the rendered title, description and labels (plus `schedule:<name>`).
Filing spends nothing; the filed task waits for the author gate like any task.
A paused or idle tick files nothing. Nothing is held in memory between ticks,
so a restart changes nothing.

### The queue is one score, not a sort key per rule

`src/queue.ts` ranks ready work by a single continuous score: priority, minus a
bounded credit for waiting, minus a fixed credit for carrying the `bug` label,
minus a credit for how close the task's own epic is to done. All three credits
are derived from the aging cap rather than tuned, and the defect credit
deliberately exceeds it — a backlog states priority in three coarse bands, so
nearly everything lands in one band where age alone decides, and age is the
order work was filed, not what it is.

New rules belong in that score, not beside it. A second sort key ahead of it
would have to restate what the score already says about priority and age, and the
project rotation reads the score to decide which tasks are close enough to
interleave.

**The epic-completion credit is squared, not linear**, in the fraction of the
epic's direct children that are done: `epicCompletionCredit` in `src/queue.ts`
is negligible for most of an epic's life and only becomes material once it is
genuinely close to closed, ceilinged at the same value as the defect credit so
finishing an epic's last task competes exactly like a fresh bug report rather
than needing a constant tuned against nothing. Linear growth would let a
freshly-half-finished epic already outrank unrelated priority-1 work, which is
"any epic wins" rather than "push the close one over the line".

The fraction comes from `epicsOver` in `src/records.ts`, which reads only the epics
a ready task sits under. `queueFrom` is the one split of ready work into the
queue and the operator's column, and both the tick and `foreman queue` call it.

### A task records what failed it, never what runs next

The rung is chosen at the moment of dispatch, from what is configured, enabled,
author-on and funded then — `authorFor` in `src/ladder.ts`. What the task
durably carries is evidence: a charge per rung that was tried and was not
enough (`failuresOf`). The ladder is an ordered list of levels, and the rungs
of one level are peers: one charge on any of them puts the whole level below
the task. The author comes from the lowest level above every charged level,
and inside it the available author-on rung whose last run started longest ago
takes the turn, so peers share the work. The last starts are read from the
runs once per tick, per role, and each dispatch of the tick counts as a start,
so one tick's free slots spread over the level and over the reviewers. The
ladder decides only who writes; who reads is the reviewers' list. `foreman
ladder level <rung> <n>` groups rungs into a level; `ladder move` puts a rung
in a level of its own, and so does `ladder add` unless `--level` names one to
join. `foreman ladder author <rung> on|off`
keeps a rung out of the author pick without retiring it.

A task that named its next model would be a pointer into the ladder, and the
ladder outlives no task: remove a rung and every task holding its name
becomes work no rung can take, which reads as a backlog full of decisions
waiting on a person. Evidence cannot rot that way — it describes what happened,
which stays true however the ladder is edited afterwards.

- **A retired rung stays listed with `enabled: false`.** It keeps its level and
  rank, so the failures naming it still position the work above it, and nothing
  dispatches it. Deleting the entry removes the model from the rating, so its
  failures do not position the work.
- **`Waiting` and `Yours` are different answers.** No rung with room is a fact
  about a wallet that an allowance reset clears by itself, so the task stays in
  the queue, marked; every configured rung having failed it is a fact about the
  work, and only a person can answer that. Collapsing them asks the operator to
  decide something no decision changes.
- **A park is the one durable way into the operator's column.** Only foreman
  writes one, when a block parks a task or no reviewer is left. Everything else
  there is derived, so it clears itself when a rung is added or an account
  resets. `descend` takes back the park first and then the charges, one level
  per call, which is how the operator's column is left without an answer
  action. Work that is not ready for an agent is a `draft`, not a park.
- **Every label foreman reads is `<kind>:<value>`** (`size:N`,
  `diagnosing:<intent>`). Rung names contain hyphens, so only a separator no
  name holds can be split without guessing. `kindOf` and `valueOf` in
  `src/records.ts` are the whole parser.

### An allowance belongs to an account, not to a rung

`Quota` (`src/quota.ts`) reads how much of each provider's allowance is already
spent. A rung with nothing left is not chosen: the author search takes a peer
in the same level that can pay, else steps up to the next level, and the
reviewer search takes another reviewer that can pay. Nothing is recorded
and no attempt is counted — an allowance is evidence about a wallet, never about
a model — so the ordinary rung is chosen again once the account resets.

- **Keyed by provider, because that is what has the allowance.** Several rungs
  naming one model share one, so climbing inside a spent account buys nothing —
  it spends a rung to meet the same wall. `providerOf` in `src/ladder.ts`
  derives the account from the model's `<provider>/` prefix, which every rung
  that names a model already states; stating it twice would let the two drift.
  The claude harness is the one default that is not in doubt — the `claude`
  binary is always signed into the claude.ai account, however it picks its
  model — so a rung on it spends `claude` even when it names no model. Any
  other rung that names no model, or names one without a provider prefix, has
  to be told; it is warned about at config load and dispatched blind, exactly
  as before this was read at all.
- **Unreadable is not spent.** A provider foreman could not reach is carried to
  the quota view with `unreadable` set and empty `allowances`, so the operator
  sees why the account is absent while the gate reads it as neither spent nor a
  wall — treating silence as a wall would stop the fleet on foreman's own
  network trouble, which is the opposite of what the gate is for. A read that
  cannot succeed until the operator acts — no usage source, a missing key, an
  expired token — is `permanent` and repeats on every poll, so it is never
  logged; only a transient failure, which may clear by itself, is worth a line.
- **Every probe has 30 seconds.** The tick waits for every provider's reading,
  so one probe that never answers stops the fleet: `codex app-server` has
  waited all night for a reply after the machine slept. `boundedBy` interrupts
  a probe at its limit, which kills its process, and the provider reads as
  unreadable (transient) until the next tick.
- **Read once per tick and handed to both observations.** A tick observes twice
  — before it acts and again before it fills — while an allowance moves on the
  order of hours, so a probe per observation is a request every few seconds for
  a number that cannot have changed between them.
- **openai is asked through `codex app-server`.** There is no endpoint to call:
  chatgpt.com refuses a plain request for a plan's remaining allowance, and the
  app server is the signed-in client that will answer. It reads EOF on stdin as
  a shutdown and answers asynchronously, so closing the pipe after writing loses
  the reply — stdin stays open behind the requests and the scope's teardown
  kills it once the reply has arrived.
- **opencode go is one GET, opencode zen is nothing.** The go subscription
  answers `/zen/go/v1/usage`, and the endpoint accepts any key of the account —
  the allowance is the account's, not the key's — which is how a zen key reads
  as go and the two get conflated. The zen account's quota is a pay-as-you-go
  balance and per-model free tiers, and no path on the public host answers for
  either (`/zen/v1/usage` is not served), so `opencode` is carried to the quota
  view as `unreadable` and never gated: its rungs always dispatch, and an agent
  meets a genuinely exhausted balance itself.
- **The key is read where the harness keeps it.** A credential copied into
  foreman's config is one more place for it to go stale, and the harness whose
  key it is renews it.
- **A rung the allowance does not describe is marked `unmetered`.** A model on
  promotional access draws on a pool the account's percentage does not measure,
  so walling it on that percentage is the one false wall there is: work the
  account can still pay for gets passed over, and the task waits for a reset that
  was never going to matter. `rungsOn` leaves those rungs off the wall and
  `providersOf` stops asking about an account whose every rung is such a one,
  which is a request saved per tick. Stated rather than derived, because only
  the operator knows what a provider is currently sponsoring — and getting it
  wrong that way is the safe direction, since a metered rung left out meets the
  wall itself, which is where the fleet stood before any of this was read.
  A config field the schema does not name is dropped in silence, so the flag is
  covered by a test that decodes a config and reads the rung back.
- **`foreman quota` and the published quota view are two callers of one
  reading.** The view shows the accounts, which is what an operator can act
  on; the command answers the same question without a running dispatcher.
  The gate reads the same reading folded onto the tasks fill would have started.

### The review gate

A task under review is still `in_progress`. Its step is the block placement puts
it at — the name the operator drew — derived from the last exit and the drawing.
Status answers only the task's life; storing a review step as a status kept one
fact twice and let the two disagree.

A task is foreman's to review only if it has an author run, which foreman opens
when an agent actually starts. **Do not weaken this into "has a worker"** — the
worker can legitimately be absent while the run is not. Tasks that predate
foreman and have no branch behind them are not reviewed: a reviewer given no
diff invents one.

An open review run records that a reviewer was dispatched, so a vanished worker
behind one is a question for the operator rather than grounds for silently
launching another reviewer. Placement standing at the review block covers both
the author's completed handoff and the whole review run.

**An empty branch is unfinished work, except when it is a finding.** A backlog
outlives the code it describes: work goes in under another task's branch or by
hand, and the entry stays open. Every ending an author can reach there says
something false — committing invents work, and stopping is indistinguishable
from a crash, so the task climbs a rung and buys the same discovery again at a
dearer model until the ladder runs out at the operator. So the author ends its
run by naming its block's claim: the one exit the drawing declares `empty:
claim` (`already-done` in the standard pipelines), and `reviewable` sends that
one empty branch to a reviewer. The meaning is the declared property, not the
name, so a renamed claim stays a claim. Validation allows one claim per author
block, and its route reaches a review before any other author or a park; a
check may stand between them.

A task labelled `research` is the second such branch: its deliverable is a report
in its own log, so it never has a diff to commit. That label is set when the task
is filed and survives a requeue, because it names the kind of work rather than
one attempt.

Both are claims, never approvals. "It is already done" is exactly what a model too
weak for a task would say to escape it, so the reviewer confirms the author's
claim against the trunk and a `research` report against its cited evidence, each
part by part, and its `approved` exit is what closes the task; a rejection
sends it back like any other. Landing needs no special case — an empty branch is
contained by any checkout, so `merge` answers `Present` and completes the task
without merging or verifying. The author run's ending and the `research` label
tell the causes of `Present` apart in the log. A new author run starts a new
lap, so a claim stops counting with no code that clears it, while `research`
names the work and stays.

Nothing skips review. A task's priority and its labels are written before anyone
has read the diff, so they cannot say whether the diff is worth reading — and
the work most likely to be filed as too small to check is the work an author is
most likely to have stubbed. An approving reviewer is the only thing that makes
a branch landable, and landing is the only code path that moves a
task's target for a local landing; a pull-request landing moves
the target on the remote instead. So no prompt gives an agent merge rights. A direct route is the operator's choice to let the author commit there,
and its `done` still waits for an approval.

The author critiques its own diff before handing off, reading `git diff` rather
than recalling its intent, because the intent is what wrote any mistake in there.
It catches the mechanical class — an unhandled case, a half-finished rename, a
test that never runs the new path. It cannot replace the reviewer: the transcript
that makes self-critique cheap is also where the anchoring lives, and a session
grading itself will not conclude that the model which wrote the code was too weak
for it, which is the evidence a rung climb needs.

The reviewer does not re-run the project's test suite. Foreman runs `verify`
either side of the merge, so repeating it changes no outcome, and several agents
on one machine each running a full suite slows every worker down for signal
already being collected. What the reviewer uniquely catches is a stub, or a test
weakened to get the suite green — neither of which is found by running tests,
since a green suite is what both produce. So it reads what the diff does to the
tests and runs only those covering the code it touched. The review prompt's workspace section renders
the project's `scripts/verify.sh` into the prompt; a project with none has no landing
gate, and there the full run is the reviewer's after all.

**The ladder is the registry's.** `src/registry.ts` reads the `ladder` and
`models` tables of the task store (`TASKS_DB`, else `~/.tasks/tasks.db`), through
the SqlClient the process shares with `Records`; `config.jsonc` has no ladder. A
store with no rungs is a startup error, not a fallback, because a
fallback is a second ladder that can drift. The model row carries the harness.
Each ladder row and each reviewer row carries its own thinking level, and
`launchArguments` in `src/harness.ts` turns it into the harness's flag; the
model has none, so a seat's level has one source. An absent level passes no
flag, and the harness's own default applies. Each ladder row stores its `level`
and its `rank`, and readers sort by (level, rank). Every ladder write (`foreman
ladder edit`, `move`, `add`, `level`, `thinking`) validates the whole ladder,
rewrites the ranks from that order, and writes it in one transaction.
The reviewers are the `reviewers` table, apart from the ladder: each row is a
name, a model, its own thinking level and an optional provider, so a model is a
rung, a reviewer, both or neither, and one model can be a low-thinking rung and
a high-thinking reviewer. A review run records the reviewer's name in the
run's `rung` column, and the run's role says which list the name is in
(`seatOf` in `src/reviewers.ts`), so a reviewer may share a rung's name.
`foreman reviewers add|remove|thinking` changes the list, and `foreman reviewers --json`
prints each reviewer with its harness, provider and `launchArguments`.
`foreman ladder --json` prints the rungs, every model and the reviewers in one
read, for a front end that draws both lists.

**Two correction rounds, counted.** A reviewer sends mechanical findings to the
live author with `foreman correct`, which refuses a third round and counts each
round on the lap's author run. The count belongs to one author, not the task, so
a new author run starts at zero. An independent second look before approving is
asked for in the review prompt and is not enforced: whether a finding is real is
judgement, so foreman asks for it in prose and records nothing about it.

**A reviewer that stops without naming an exit is the reviewer's failure, not the
author's.** The task stays `in_progress` at its review step, and its review run
ends `stopped`; `reviewerFor` then passes over every reviewer whose review in
this lap ended that way. No attempt is charged to the author. When no reviewer
of the block is left the task is released and parked. A reviewer stopped on a
usage wall ends `walled` and charges no rung. A reviewer whose approval a later
commit voided has not failed: the same reviewer may read the new tip. A
reviewer is no rung, so a review block may not draw `fails: self`. This is the
review block's `stopped: retry`; a block drawn with `stopped: park` parks the
task at the first stop instead.

**Review state is the current lap's runs.** A lap is the task's latest author
run and every run after it. A new author run leaves the last lap's reviews
behind, so no transition clears review state, and no path can forget to.

**A review passes one commit.** The reviewer runs `foreman exit <task>
approved|returned`, which reads the task's tip by its route and writes the exit
and that commit to its run, and moves the status the exit implies, in one
transaction. The exit may carry notes, which are stored on the run and printed
by `foreman show`. A second exit in the same run replaces the first, notes
included. The exit holds only while the tip is still that commit, so any other
commit after it voids it, and a correction round needs no special case:
the reviewer names its exit after the round, on the new tip. For a local
landing, foreman re-checks the checkout and the tip, merges the approved commit by its id, never
the branch name, and only then completes the task. A pull-request landing
merges with `--match-head-commit`, and the task completes when foreman reads
the PR merged. A tip that moved since the
approval is refused, and the task goes to review again.

The drawing decides where a returned review goes. In the standard pipeline it
keeps the claim and workspace and waits at the `climb` gate before the next
author. See "The standard pipeline, drawn with exits" in `docs/agent-exits.md`.
Saved pipelines keep their drawn returns to the queue.

**A local landing is proved somewhere disposable before it is applied.** A
pull-request landing is proved by the repo's required checks instead, and the
proving ground does not run. The merge is
made, and the project's `verify` is run, in a per-project proving ground —
`verifyDirectoryFor` in `src/fleet.ts`, a detached git worktree reset to the
target's current tip. Check blocks run their command there too, at the task's
tip, after the landings.

**What lands is that commit, not a merge remade from the same parents.** The
ground shares the repository's objects, so the proved commit is addressable from
the checkout, and git fast-forwards onto it, or moves the target's ref to it when
no checkout has the target out. The target therefore takes the
exact tree that was verified, and the apply cannot reconcile anything —
which is what makes a refusal there provably about the machine.

Every property that makes this the design follows from the operator sharing that
checkout. A test suite spawns its own processes, and running one in a directory
somebody is using strands the `index.lock` that the landing's own git then trips
over. And the undo disappears entirely: backing a merge out was only ever needed
because the merge had to be applied to be tested, and a `reset --hard` that fails
leaves an unverified merge sitting in the shared checkout with nothing to say so.
The proving ground is reset from the target's tip on the next landing anyway,
so nothing there ever needs undoing.

The ground is per project, not per task — landings are serialised by the tick,
and reusing it is what lets `scripts/worktree-setup.sh` keep its installed
dependencies between landings instead of paying for a cold install every time. A
ground whose setup fails holds the project: a verification that could not run
must never read as green.

The tip is read again after the proof and before the apply. A merge proved
against a commit the operator has since moved past is not the merge that would go
in, so the landing holds and a later tick proves and applies the same one.

**A merge that did not happen and a merge that would not happen are different
answers.** Only the second is about the branch, and only the second may climb a
rung. So the conflict is **asked about, not inferred**. git's exit status
cannot carry the distinction: it reports a lock it could not take through
the same non-zero codes as content it would not reconcile, and only the
diagnostic text separates them. An unmerged index entry is the durable fact
instead — git writes one per conflicting path and nothing else does — so it is
read from the proving ground's index right after the merge, and an unreadable
index holds rather than climbs. Everything not a conflict is `Held`, and `Held` carries
a `reason` and a `detail` — the same verdict the dispatch gate's `isFree`
returns, so landing and gate never disagree about why a checkout is busy. A
`dirty` hold clears itself and is not worth a line every poll; any other reason
never clears and must not retry in silence.

That distinction lives wholly in the proving ground. By the time the branch
reaches the operator's checkout it is proved mergeable against exactly that
commit, so a refusal there cannot be about content — it is `Held`, always.

`Held` is also what keeps an `approved` exit alive. It leaves the task
`in_progress` at its land step and the tip where it was, so a later tick lands
the same reviewed commit; nothing about a lock invalidates a diff a reviewer
already read.

A local landing also runs `verify`. Only a ground that was green and reproducibly went red
is the branch's fault: the output is logged and the task returns to the queue.
A checkout already red still accepts the merge, because a branch cannot be
blamed for damage that predates it and one broken test would otherwise freeze the
whole fleet. A project with no `scripts/verify.sh` lands on the merge's success alone, and
the task log says so.

**The baseline is lazy, and that is not an optimisation.** The merged ground is
verified first; only if that fails is the pre-merge baseline worth running,
because only then is "was it red already?" a live question. A failure is also
repeated once on the same merged tree before the baseline, because a suite that
fails and then passes found nothing: a pass on the retry is a flake, the branch
lands verified, and the failure is logged for the operator to file. So a flake
costs two runs, a confirmed break costs three, and the question asked of the
baseline is a confirmed failure. The tick is one fiber, so a verification run is
time in which nothing else is dispatched, settled or landed, and an eager
baseline made every good landing cost two full suite runs. Never worse where it
matters, and half the price in the common case.

**A landing is several steps and only the merge is atomic.** Interrupt it after
the merge — a stranded `index.lock` is enough — and the commits are in while the
task still reads as awaiting a landing, so every later tick lands the same branch
again. So landing's first question is whether the target already contains the branch,
and an already-merged one returns `Present`: the task is completed without
merging or verifying. Re-merging is a harmless no-op, but re-verifying is not —
it is a full suite run the whole one-fiber tick waits out, repeated forever for a
task that is done. It is asked ahead of the clean gate, because a checkout that
already has the commits is not going to be written to, and holding there would
strand the task for as long as the operator kept editing.

Landing waits for the reviewer's terminal to stop working (`readyToLand`): it
stays `working` from the moment the exit is named until the turn ends, and
teardown runs `worktree remove --force` on the directory the reviewer is
standing in.

### The branches are the third source of truth

Every other column comes from the task store, which stops mentioning a branch the
moment its task is closed, reclaimed or deleted — while the commits stay. So
`Repository.branches` reads foreman's refs directly and answers three questions
off one read per project, each against the branch it lands on, its upstream (a
branch with none, or whose target git lacks, answers neither):

- **`merged`** — the target already contains the tip, so the ref is free to delete.
- **`empty`** — the tip is still on the target's first-parent line, and the
  branch's reflog says it was created at that tip, so nothing was ever
  committed on this branch.
- Neither — the branch holds work its target has not taken.

**`merged` cannot stand in for `empty`.** An author run proves foreman authored
a branch; it does not prove the author wrote anything, and an agent can run
`foreman exit <task> done` having committed nothing. Asking only "is this branch unmerged" and
reading "no" as "nothing was committed" hands finished, merged work back to the
queue as empty. A merge landing keeps the first-parent line to the commits the
checkout held before any branch touched it, but a fast-forward landing puts the
branch's own commits on it. So `createdAt` reads the oldest reflog entry of the
branch: a tip on the line that moved since the branch was created holds work. A
branch whose reflog is gone reads as work: an unknown creation is no evidence
that nothing was committed, and a reviewer reading an empty diff costs less than
finished work handed back as empty.

The sweep is not a step inside landing. Every tick, in every project, the
dispatcher deletes refs that are `merged` **and** whose task is absent from
the queue, the claims or the review list **and** whose task the store, asked
again at delete time, reports closed or gone — so a branch merged by hand disappears
the same way a landed one does. The re-ask is needed because the lists are
read at different moments: a dispatch landing between them leaves a fresh,
empty (so "merged") branch in none of them. All halves are required: sweeping on `merged`
alone deletes the branch of a task still under review, which is the evidence the
next tick needs to tell work from nothing. `--delete` without `--force` is the
backstop, since git refuses to drop commits the checkout does not have. A clean
linked worktree still holding the merged branch is removed first, so a landing
whose teardown failed does not leave the branch pinned forever; one with
uncommitted or untracked work refuses, and the branch waits.

What is left over is **unreviewed**, and `isUnread` is the whole rule: unmerged,
and its task in no status that still reaches an agent. `open` and `in_progress`
both end with the branch read — the queue resumes it, a claim is worked or
reclaimed, a review reads it — so a queued task with commits behind it is not
abandoned but next in line, and the queue already works oldest first.
Listing those names the ordinary case as an exception, and dispatching a
reviewer at one reads a diff its author is half way through.

`recover` then works the list off without the operator, one per tick, oldest
first: `submit` on the longest-waiting one, and the review pass dispatches. No
counter is needed, because submitting the oldest is what makes the next tick
see a different oldest. **Only `done` is recovered.** It says somebody meant to
keep the work, so unmerged commits mean a landing that stopped part way — which
is foreman's own doing and foreman's to correct. A `canceled` task is a decision
a person made, and an automatic review spends a rung relitigating it; a deleted
one has no id to dispatch against. Both are shown, and `adopt` submits one by hand.

### One terminal per role

Two roles run agents: `author` and `review`. A check block records a run of
role `check`, which runs a command, not an agent. Each runs in its own hc terminal
labelled `fm.role`, and a worker's `roles` map is read back from those labels
every tick (`workersOf` in `src/hc.ts`), not from foreman's memory. Every agent
of a task shares one herdr-app tab, so a reviewer opens beside the author it
reads (`placementOf`).

**Only work in progress refuses a dispatch.** A role that is `working` or
`blocked` rejects a second agent, because two agents in one worktree edit over
each other. A _settled_ one does not: it has stopped, it is editing nothing, and
nothing will ever end it. Reading settled as live turns every worker foreman
deliberately keeps into a permanent stall — the dispatch is refused, the caller
hands the claim back, the queue offers the task again, and the refusal repeats
every poll forever.

So a terminal already carrying a role is never reused, not even by the same
role. The replacement starts first and the spent terminal is ended after; that
order is what ends the settled agent inside it.

**A settled agent is ended at the settle, not at the next dispatch.** It is
editing nothing and will never work another turn, but it still holds its model's
resident memory — enough of it that a full fleet exhausts this machine. `slots`
does not bound that: `busy` counts `working` and `blocked`, so a settled agent
frees its slot and keeps its process. Each settle path that has already written
its record to the store therefore ends with `stopAgents`: the reviewer that
returned work, the reviewer that stopped without an exit, and the reviewer
waiting out a held project. An agent that named an exit is ended once its pane
is idle, and the next tick places its task where the exit leads. The author
that named `done` is the exception until
`coachWindowMinutes` pass (`handoffExpired`), so a reviewer can send it a
correction with `foreman correct`. What the agent did is in the task's log,
which is where the next one is told to read it.

Ending a task's last terminal is the intended end of that. The worktree and its
uncommitted edits outlive it, and `Fleet.open` re-adopts them.

The one settle deliberately not ended is a **vanished** worker, which has no
running agent to end.

## Ports

`Fleet` (`src/fleet.ts`) is the whole multiplexer surface. `HcFleet` in
`src/hc.ts` is one implementation; another multiplexer would be a second, not a
rewrite.

`Tracker` (`src/tracker.ts`) is the whole task-tracker surface, in tracker
terms: tasks, their status moves, labels and logs. `ProjectTracker` there
routes each call to the adapter of the project's tracker, chosen with
`foreman policy tracker` (docs/issue-trackers.md); `TasksTracker`, over the
`tasks` package, `githubTracker` (`src/github-tracker.ts`), over `gh`, and
`linearTracker` (`src/linear-tracker.ts`), over Linear's GraphQL API, are
built. Nothing above `src/github.ts` runs `gh`, and nothing above
`src/linear.ts` sends HTTP to Linear. `Records` (`src/records.ts`) holds foreman's
own records beside it, keyed by task id: the runs, the charges and the parks.
For a tasks project, a records write that goes with a status move shares one
transaction with it, which holds only while both run on one store connection;
`Records.layer` builds them that way. A GitHub or Linear project writes the
records first, then the move (`docs/issue-trackers.md`, section 1). The writes a pipeline event makes are one
row of the joint table: `stepOf` in `src/run-step.ts` decides the row from the
task and the rules alone, and `Records.write` writes it. A path that writes
for one of its `RunEvent`s builds the event and calls `stepOf`; it does not
call the run, charge or status writes itself, so the tracer reads the same
rules. The moves no `RunEvent` covers are listed under "Not in the table" in
`docs/task-and-run-machines.md`.

`Repository` (`src/repository.ts`) answers what foreman needs to know about a
project's git checkout. Nothing above that file runs `git`.

`Quota` (`src/quota.ts`) answers what a provider has left of its allowance.
Nothing above that file knows which endpoint or which client says so.

## Forking for your own workflow

To change how foreman works, edit one of these.

| To change                           | Edit                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| where tasks come from               | write a `Tracker` (`src/tracker.ts`); `TasksTracker` is the example                                                             |
| where agents run                    | write a `Fleet` (`src/fleet.ts`); `HcFleet` in `src/hc.ts` is the example                                                       |
| the steps a task goes through       | `standardPipeline` in `src/pipeline.ts` (`foreman pipeline use` draws one, with `--land` and `--onto`), or draw one on the page |
| what an agent is told               | the files in `~/.config/foreman/prompts/`                                                                                       |
| which models run, and in what order | the ladder, with `foreman ladder edit` (`src/registry.ts`)                                                                      |
| which models review                 | the reviewers, with `foreman reviewers add` and `remove` (`src/registry.ts`)                                                    |
| what runs without asking            | the policy file (author, climb, review, publish, land)                                                                          |

Keep `Records` and `Repository` as they are: the runs and git are how foreman
knows what happened, whatever the workflow.

## Front ends

`foreman serve` writes every reading to `state.json` (`src/published.ts`).
The herdr-app Foreman pane (`herdr/foreman/main.js`) shows the project of the shown space. It
reads `state.json`, and reads the queue and a task's record through
`foreman queue` and `foreman show` (`src/store-commands.ts`). Its Pipeline view
draws the `drawing` that `foreman pipeline show --json` prints, laid out by
`src/pipeline-layout.ts`, because a mod cannot load foreman's modules. Its
`--flow` is `down` in a pane taller than it is wide, else `across`. It edits a
project's draft through `foreman pipeline edit`, `save` and `discard`, and the
block kinds, steps, roles and landings it offers are the `choices` in that JSON.
An exit wired into a block that reaches it back is a back wire, laid out on a
return lane past every block and drawn dashed. While the operator edits an agent
block, the pane edits its instructions through `foreman pipeline instructions`
and shows the prompt the block sends a pretend task from `foreman pipeline
prompt`, which renders through `Prompts.agent` as `foreman prompt` does.
`foreman pipeline trace <project> --json` walks a pretend task through the
draft with the events a front end chose, from scratch on each call
(`src/pipeline-trace.ts`). It folds the dispatcher's own rows over a task held
in memory, and after each event prints the placement, the route so far and the
events the block offers next, so a front end shows what the dispatcher would do
without a copy of its rules. The pane's simulate controls
(`herdr/foreman/simulate.js`) call it after each choice and after each
change to the draft. `foreman pipeline simulate <project> --json` plays the
project's ready and claimed tasks through its draft and through the pipeline it
runs, on one seed, so the pane can compare the two and animate the draft
(`src/pipeline-simulate.ts`). After each event it plans with the dispatcher's
own `candidatesFrom` and `planFrom` and folds the trace's events; only each
run's outcome and minutes, and each check's result, are drawn, from the runs
table's rates per rung, blended toward the role's pool (`src/run-rates.ts`).
Landings and checks wait for the next tick, one poll interval after the tick
before, as in the fleet. Each frame holds only the tasks that moved, so the
board at a frame is the fold of the frames up to it. Its `assumes` names every
fact it does not read from the world. The pane's fleet controls
(`herdr/foreman/fleet.js`) call it on demand and after each change to
the draft, and draw the frames on the board up to a time the operator picks. Both act through
`foreman <action> <id>` and `foreman policy`. Neither runs `tasks`. `state.json`
is a view, not a memory: nothing in foreman reads it back.

`src/view.ts` is a total function from a reading (`FleetState`) to rows and the
actions each row takes, with no renderer, which is why its test is plain
assertions. `src/actions.ts` turns an action on a row into a dispatcher command
through `perform`, and `src/commands.ts` exposes each action as a subcommand. A
new action is an entry in `ACTIONS_LIST` and the column tables in
`src/view.ts`, a case in `perform`, and a line in `ACTION_HELP`.

A one-shot command runs `Dispatcher.read` — a tick's observation, acting on
nothing — then finds the row its id keys. It does not talk to the dispatcher:
the world and the operator's two files are the only channels, so what it changes the
dispatcher reads on its next tick. **Settle, land and tick have no command.**
Landings and checks are serialised by the dispatcher's one fiber over one
proving ground per project, checks after the landings; a second process landing races it.

Agents read, log and file tasks with `foreman show <id>`, `foreman log <id> -`,
`foreman list -p <project>` and `foreman add`, which route through
`ProjectTracker`, so no prompt names a tracker's own CLI. A worker files but
never dispatches: starting agents is the operator's, so `foreman dispatch` and
`foreman add --dispatch` refuse a caller whose hc terminal carries the fleet
label (`Fleet.inWorker`), and `add` refuses before it files.

`foreman --skill` prints `src/skill.md`, read at runtime like the prompts, so
the usage an agent reads ships with the binary it describes.

### The views

The views are queue, working, review, landed, quota and attention (`VIEWS`).

The quota view is the accounting behind the fleet: every account the ladder
draws on, spent or healthy or unreadable, each window with its own percent and
reset. The label names the state when the state is news — `out of quota`,
`unreadable` — and is otherwise just the account, because an account with room
is the ordinary case. The spent ones also sit in attention as the last row: a
fleet that has stopped dispatching must say so without being searched for, and
the row there is the same one, carrying the rungs it stops — the answer to
"what do I move off this account". A quota row takes no action, because the
fix is moving a task onto another account's rung, and that action lives on the
task in the queue.

In `foreman queue`, each epic with a queued task leads as a row just before the
first of its tasks (`queueRows`), not as a view of its own, because an epic is
read to decide what the queue under it should do next. An epic row takes no
action: it has no branch and no worker.

Attention combines the exceptional states in urgency order: decisions
(vanished workers, failed dispatches and lost exits), yours, stranded
projects (authored mid-pipeline work outside the managed set), stale reviews,
unreviewed branches, orphaned workers, held projects, and last the spent
accounts. Each row keeps its source kind, so
combining their display does not combine their actions. A stranded row takes
no action: the fix is reopening a space for that project.

Every reading carries `observedAt`, when the dispatcher last read the world. A
running tick publishes its reading and _then_ works, so its age tells a reader what the
fleet is doing: seconds mean a fleet cycling on its poll interval; minutes mean a
tick is inside something long, usually a landing running a test suite. Without
it a working fleet and a wedged one look identical. The same reading carries
`availableMemory` and per-worker RSS (`workerMemory`), from Linux `/proc`, so
the status line can show what agents hold beside that age. The figure is a hint
— free below the largest live worker means another would not fit — never a
dispatch gate; `slots` still meters concurrency.

Each source kind allows only the actions that make sense there, and `perform`
refuses an action the row cannot take. Decisions are named from the task's
status: only the status — neither claimed nor under review — marks a worker as
residue.

The two corrections follow the records, not the views. `descend` forgives the
charges at the highest charged level, because a charge is only ever as good as
the evidence that wrote it and a bug, an OOM or a killed run all write one
nothing earned; one level per call, so the floor drops one level, and with
nothing charged there is nothing to take back. A forgiven charge
stays in the table, marked, so the history keeps it. `unassign` ends
an open review run no reviewer is behind, as `released`, which charges no rung —
the world records whether a reviewer was dispatched, not whether it is still
alive, so only the operator can say the run is stale. Both write exactly what foreman itself would have written.

`intervene` acts rather than silently editing a rung. Continue stops the live role,
preserves its worktree and uncommitted edits, and dispatches the rung the
operator names. Diagnose and Review are offered only where git or a surviving
worktree proves an attempt left work. Committed Review uses the review agent and its exits
pipeline; uncommitted Review and Diagnose run a chosen diagnostic agent, which
may fix trivia and logs findings before foreman resumes the original rung.
`diagnosing:*` is the durable marker that makes this survive a restart; no
in-process intervention state exists.

`yours` takes no answer action. A task waits there because a question about it is
unanswered, and one action to requeue it would hand the next agent that same
question — the failure the column exists to prevent. A task there for the
durable reason leaves when the operator writes the decision into it and runs
`descend`, which removes the park; one there because evidence exhausted the ladder leaves
when a rung is added or a failure is taken back. The two corrections do reach it,
since a task parked at the operator is exactly the sort of rung that can turn out
not to have been earned.

## Traps

- **Do not run `foreman serve` to check that it starts.** It runs
  a dispatcher that reads your policy file and open spaces, so it dispatches live
  agents against the real backlog within one tick wherever the policy allows,
  and the serve lock refuses it while the service runs. Typecheck instead; for a live run,
  follow `e2e/README.md`. A smoke test's tasks enter the live queue whenever a
  herdr-app space is open on its project.
- **A reader of stdout alone sees a refusal as success.** hc reports a
  failure on stderr with a non-zero exit. `exec` in `src/hc.ts` collects the
  exit code and both streams; a new adapter over a command line must too.
- **Module resolution breaks outside the project directory.** Scratch scripts
  that import `./src/*` must live in the repo root.
- **Landing belongs to foreman, not the reviewer.** The reviewer names its
  exit with `foreman exit`. Foreman owns the clean-checkout gate, merge,
  verification and completing the task. With a pull-request landing and land
  off, the operator merges on GitHub, and foreman completes the task when it
  reads the merge.
- **The live stores belong to the running fleet.** The dispatcher reads
  `~/.tasks/tasks.db` and `~/.config/foreman/`, so a test or one-shot command
  that writes them changes the live fleet. Write them only through
  `foreman log`, `foreman add` without `--dispatch`, and `foreman exit` for
  your own task. Otherwise point `TASKS_DB`, `FOREMAN_STATE`, `FOREMAN_POLICY`,
  `FOREMAN_PIPELINES` and `FOREMAN_CONFIG` at scratch paths. To read real data, copy the store first:
  `sqlite3 ~/.tasks/tasks.db ".backup <scratch>/tasks.db"`.
- **oxfmt runs from `packages/foreman`.** Its config is
  `packages/foreman/.oxfmtrc.json`.
- **`CLAUDE.md` is a symlink to `AGENTS.md`.** `sed -i` or `perl -i` on it
  replaces the link with a copy. Edit `AGENTS.md`.
- **The operator's screen is live.** Leave herdr-app spaces, panes and focus
  alone.

## House rules

- Never patch around a wall. No flags, special cases, conversion shims, or
  parallel paths to make a broken design compile. The bugs above were fixed by
  deleting a concept, not adding one. Report a blocker instead.
- Use `tasks` for task tracking.
- Bun, not node. Effect-TS throughout.
- Edit only this repository. When a sweep reaches another project the operator
  owns, list those files and file the work with `tasks -p <project> add`. A
  project the operator does not own gets no task of its own.
- **A gap in hc or herdr-app is a foreman task, not a workaround here.**
  Foreman builds on them but does not own them, so file nothing in their
  trackers. A workaround is a shim here that encodes what hc should have told
  us. Record the missing capability, not the symptom, in a foreman task, and
  mark the foreman work that waits on it as blocked by that task.
