# Working on foreman

The README says what foreman does. This says why it is shaped the way it is, and
which walls are already known so you do not walk into them again.

Keep it that way. This file is loaded into every session and read by every agent
the fleet dispatches, so its length is a cost paid on every turn. Record the
constraint and the reason it exists — never the incident that revealed it. No
dates, no task ids as evidence, no counts, no proof-run narration.

## Status

The tree is one `Dispatcher` service over `Fleet`, `Prog` and `Repository`. It
runs in one place: herdr-web's server hosts it through `src/host.ts`
(`buildHost`), supervised, and restarts it after a failure. `src/main.ts` is the
command line, and every command there is one-shot.

Proven live: the author → review → merge pipeline end to end. The rig is in
`e2e/` — read `e2e/README.md` before running it.

- **The quota gate is unproven inside a tick.** Both probes are proven live
  through `foreman quota`, and the pass-over is proven by unit tests, but no
  dispatcher has yet declined to dispatch because of one. Watch a run at
  `foreman policy slots 1` against a spent account before trusting it to hold
  the fleet.

## The design, and why

### The world holds the work, the policy file holds the intention

The world is authoritative for the state of the work, not the process. A
dispatcher whose memory is authoritative loses the fleet on every restart: tasks
stay claimed, agents keep running, and nothing can tell foreman's own work from
a claim made by hand.

| Question | Answered by |
| --- | --- |
| What am I working on? | the worktree git has registered for `foreman/<task-id>` |
| Who authored this branch? | the task's `by:<rung>` label |
| Is a reviewer assigned? | the task's `review-by:<rung>` label |
| Which rung comes next? | the cheapest configured, enabled, funded rung above every `failed-by:<rung>` label, off the accounts in the task's `walled:<provider>` labels |
| How many tries has this rung had? | the task's `attempt:<rung>:<n>` label |
| Is this one waiting on a person? | every configured rung has failed it, or it carries `needs-you` |
| Is this task mine to review? | it has a `by:*` label |
| Is this worker mine? | the checkout in its terminals' `fm.repo` label |
| Which projects are in play? | the git checkouts of the operator's open herdr-app spaces |
| Is this project free to work in? | `git` in its checkout |

Every tick reads all of it back, so a restart re-adopts its live workers
instead of orphaning them.

The policy file (`src/policy.ts`) is the one durable thing foreman holds,
because nothing in the world records the operator's intention: `paused`,
`slots`, a default for each spending step (`author`, `climb`, `review`, `land`)
(`on` runs it, `ask` holds it for one approval per task, `off` does nothing),
grants that widen the default for one task or epic, and `projects`: a
project's own `paused` and its own mode for any step, which replace the
default for that project's tasks only. A paused project takes no step, grants
included; slots stay fleet-wide. `foreman policy` and the panel write it
through `updatePolicy`. The dispatcher reads it every pass, and
writes only which tasks each grant admitted and which grants expired, so a
grant's count survives a restart. It is a file, not process state, because a
restart of the host is not an operator. The dispatcher also watches the file
and publishes a change at once, outside the tick, because a tick can take
seconds and the operator's click should show in the reading before it ends.

`modeOf` in `src/policy.ts` reads three states out of it. `paused` is the
operator's stop; `idle` is every step off and no grant; `running` is anything
else (a step on by default or for any unpaused project, or a grant), so an
`ask` step runs the fleet: it must read the world to find what to ask about.
Only a running tick acts: a paused or idle tick reads the world and publishes
the reading, and writes nothing to prog, git, hc or the policy file — settle,
tidy, reclaim and recover wait too. Stopping the fleet must hold the world still
while the operator looks at it. To empty the pipeline without taking on new
work, turn `author` and `climb` off and leave `review` and `land` on.

An ask is a reading, not a record. `dispatchFrom` plans each tick's dispatches
and asks together. A slot is spent when a step runs, not when it is asked about,
so an ask holds no slot: review, climb and land asks are listed whatever the free
count and never hold back a granted task behind them. Author asks are capped at
`slots`, so an `ask` author step does not list the whole queue. An approved step
waits for a free slot like any dispatch. `foreman approve <id>`
answers one with an ordinary one-task grant for the asked step, which the next
tick takes; nothing else stores approvals. `foreman wait --asks` returns when a
new ask appears, for a coordinator that answers asks while it talks to the operator.

A grant permits a step. It never reorders the queue: `fill` walks the queue in
its order and passes over each task no permit covers. Which granted tasks may run
at once is what `prog ready` returns, so the plan's blockers decide it, and
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
`commanded` in the dispatcher's own process or `wake` from its host once a
one-shot command in another process changed the world.

**Durable state beyond the policy file is a wall.** Needing it means something
the world should record is not being recorded, and the fix belongs in hc,
herdr-app or prog.

### Projects are the open spaces

The config lists no projects. A project is the git checkout an open herdr-app
space sits in, named by the checkout's folder, which is also its prog project
(`src/projects.ts`). Only an open project takes new work; the managed set adds
every checkout a foreman agent still runs in, so closing a space drains the work
under way. Two checkouts with one name are held as `ambiguous`, because a task
names a project, not a directory. A project's verify command is its own
`scripts/verify.sh`.

### One worktree per task

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
needs an answer — and asking it means one `prog show` per worker on the
machine before knowing whether any of them is this dispatcher's. A worker with
no `fm.repo` checkout has nothing to be scoped by and is nobody's.

What survives that scope and the store then denies is an **orphan**: a
worker whose task was deleted under it. No column shows it, no slot counts
it and no tick will dispatch into it, so it is surfaced in attention with one
action, `close`. Not swept, because the worktree may hold uncommitted work and no
task remains to say what it was. This is why `Prog.lookup` answers `Option`
rather than failing: "there is no such task" is a fact about the world, while a
store that would not answer says nothing at all and must leave the worker
alone. `Prog.show` is `lookup` with the absent case made an error, for the
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
claim foreman's own agent made, which its `by:*` label records. A claim made by
hand or by another session is its owner's to give up: foreman cannot tell an
abandoned one from one whose owner is away.

Absence is an unknown, not evidence. A task climbs a rung on real evidence only:
a reviewer sending work back, a branch that broke the project's verification, or
a rung spent by `attemptsPerRung` unfinished endings. A branch that merely would
not **merge** is none of them: every author cuts from the trunk's tip, so a
branch whose tip has not moved fast-forwards and cannot conflict — a conflict
therefore means the trunk moved afterwards, which no model is stronger at
avoiding. It returns to the queue at the same rung, with the conflicting paths
on its log, and the ordinary unfinished count still bounds a task that cannot
get past it. An agent that merely stopped without
finishing has said nothing about its model — a crash and a timeout end the same
way — so the task stays on the rung and is tried again. The count of those
endings lives on the task as an `attempt:<rung>:<n>` label, because a dispatch
days later is exactly what reads it.

A usage wall is the one stop that says something, and it says it about the
account, not the model. Each harness's wall text is listed in `src/harness.ts`,
read from the screen of the stopped author, and matched only at the foot of it.
A wall writes `walled:<provider>` on the task and no attempt or failure, so the
next author skips that account. The label clears when the task completes.

### The operator's checkout is shared, so it is asked about

Every task ends by merging into the project's main checkout, the one the operator
edits in. `Repository.isFree` is the dispatch gate: a project it answers `Held`
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

A checkout with no branch is held. The branch a landing moves is whichever
one `HEAD` names, and `git merge` into a detached `HEAD` succeeds: the commits
land, the operator's branch stays put, and the tick sweep then deletes the only
ref that reached them. "Free to work against" means there is a branch for the
work to land on.

An unreadable repository counts as held — foreman cannot merge into a checkout it
cannot read either.

The dispatch gate cannot be the only gate, because a tree can go dirty in the
hours between an agent starting and its branch being ready. `Repository.merge`
asks the same question again before it proves anything (only the already-merged
check below comes first) and returns `Held`: the landing is not attempted, the
verdict stays on the task, and a later tick lands it. No prompt is involved,
because no agent merges.

Agents stay out of that checkout entirely. `git` commands there refresh the
index, which collides with a landing mid-merge and leaves `index.lock` behind;
foreman's own reads set `GIT_OPTIONAL_LOCKS=0`, and an agent's cannot be made to.
`Repository.base` resolves a branch's fork point so a reviewer can diff
`<base>..HEAD` inside its own worktree. Onboarding is the one exception, and only
ever on a project already held.

### Onboarding is the one agent inside the operator's checkout

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

Settle, tidy, reclaim, recover, then fill — and **reviews are filled before new work**. A task
awaiting review is nearly finished and is blocking whatever depends on it,
whereas an unclaimed task has not started costing anything. Filling slots with
new work while reviews pile up grows a permanent tail of almost-done tasks.

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

The fraction comes from `epicsOver` in `src/prog.ts`, which reads only the epics
a ready task sits under. `queueFrom` is the one split of ready work into the
queue and the operator's column, and both the tick and `foreman queue` call it.

### A task records what failed it, never what runs next

The rung is chosen at the moment of dispatch, from what is configured, enabled
and funded then — `authorFor` in `src/ladder.ts`. What the task durably carries
is evidence: one `failed-by:<rung>` label per rung that was tried and was not
enough. The author is the cheapest available rung above all of them.

A task that named its next model would be a pointer into the ladder, and the
ladder outlives no task: remove a rung and every task holding its name
becomes work no rung can take, which reads as a backlog full of decisions
waiting on a person. Evidence cannot rot that way — it describes what happened,
which stays true however the ladder is edited afterwards.

- **A retired rung stays listed with `enabled: false`.** It keeps its rank, so
  the failures naming it still position the work above it, and nothing
  dispatches it. Deleting the entry outright is the other statement — the model
  is no longer part of the rating — and its failures then position nothing.
- **`Waiting` and `Yours` are different answers.** No rung with room is a fact
  about a wallet that an allowance reset clears by itself, so the task stays in
  the queue, marked; every configured rung having failed it is a fact about the
  work, and only a person can answer that. Collapsing them asks the operator to
  decide something no decision changes.
- **`needs-you` is the one durable way into the operator's column.** Everything
  else there is derived, so it clears itself when a rung is added or an account
  resets. `descend` takes back the park first and then the failures, one call
  at a time, which is how the operator's column is left without an answer action.
- **Every label is `<kind>:<value>`.** Rung names contain hyphens, so the older
  `attempt-<rung>-<n>` could only be read by guessing where the model's name
  ended — and durable labels make that guess again on every dispatch, forever.
  `kindOf` and `valueOf` in `src/prog.ts` are the whole parser.

### An allowance belongs to an account, not to a rung

`Quota` (`src/quota.ts`) reads how much of each provider's allowance is already
spent. A rung with nothing left is not chosen: the author search steps up to the
next rung that can pay, exactly as the reviewer search does. Nothing is recorded
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

`reviewing` is a status anything can set, including tasks that predate foreman
and have no branch behind them. Dispatching a reviewer to one gives it no diff to
read and nothing to merge; it will invent something.

A task is foreman's to review only if it carries a `by:*` label, which foreman
writes when an agent actually starts. **Do not weaken this into "has a
worker"** — the worker can legitimately be absent while the label is not.

`reviewing` also does not say whether a reviewer was dispatched: it covers both
the author's completed handoff and the whole review run. `review-by:*` records
the latter, so a vanished worker under that label is a question for the operator
rather than grounds for silently launching another reviewer.

**An empty branch is unfinished work, except when it is a finding.** A backlog
outlives the code it describes: work goes in under another task's branch or by
hand, and the entry stays open. Every ending an author can reach there says
something false — committing invents work, and stopping is indistinguishable
from a crash, so the task climbs a rung and buys the same discovery again at a
dearer model until the ladder runs out at the operator. So the author records a
`satisfied` label, and `reviewable` sends that one empty branch to a reviewer.

A task labelled `research` is the second such branch: its deliverable is a report
in its own log, so it never has a diff to commit. That label is set when the task
is filed and survives a requeue, because it names the kind of work rather than
one attempt.

Both are claims, never verdicts. "It is already done" is exactly what a model too
weak for a task would say to escape it, so the reviewer confirms a `satisfied`
claim against the trunk and a `research` report against its cited evidence, each
part by part, and its `approved` is what closes the task; a rejection sends it
back like any other. Landing needs no special case — an empty branch is contained
by any checkout, so `merge` answers `Present` and completes the task without
merging or verifying. The labels are what tell the causes of `Present` apart in
the log; `satisfied` is cleared wherever `approved` is, since both describe a
diff that a requeue has invalidated, while `research` names the work and stays.

Nothing skips review. A task's priority and its labels are written before anyone
has read the diff, so they cannot say whether the diff is worth reading — and
the work most likely to be filed as too small to check is the work an author is
most likely to have stubbed. An approving reviewer is the only thing that makes
a branch landable, and landing is the only code path that writes to the
operator's checkout, so no prompt gives an agent merge rights.

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
tests and runs only those covering the code it touched. `Prompts.review` renders
the project's `scripts/verify.sh` into the prompt; a project with none has no landing
gate, and there the full run is the reviewer's after all.

**The ladder is the registry's.** `src/registry.ts` reads the `ladder` and
`models` tables of the herd skill's trials database; `config.jsonc` has no
ladder. A missing database is a startup error, not a fallback, because a
fallback is a second ladder that can drift. The model row carries the harness
and the thinking level, and `launchArguments` in `src/harness.ts` turns the level
into the harness's flag. `foreman ladder edit` is the one way to change the
order: it validates the whole edit and writes it in one transaction.

**Two correction rounds, counted.** A reviewer sends mechanical findings to the
live author with `foreman correct`, which refuses a third round and writes
`rounds:<n>`. The trial row reads that label, and `attribute` clears it, because
it counts one author's rounds, not the task's. The council review the prompt
asks for before approving is not enforced: whether a finding is real is
judgement, so foreman asks for it in prose and records nothing about it.

**A reviewer that stops without a verdict is the reviewer's failure, not the
author's.** The task stays in `reviewing`, `review-by:*` goes, and
`review-failed-by:<rung>` records the stopped rung; `reviewerFor` then reads
above the author and every recorded reviewer. No attempt is charged to the
author. When no rung is left the task is released and parked with `needs-you`.
A reviewer stopped on a usage wall hands off the same way, writing
`walled:<provider>` and no failure. `review-failed-by:*` goes with the author
(`attribute`, `release`, `clearReview`); a spawn failure ends only `review-by`.

**Whatever ends a review clears `review-by:*`.** A label left behind is read as
evidence of something that never happened: a reviewer that is over on a task
that is open is exactly the shape a rejection leaves, so the settle loop takes
it for one — climbing a second rung and logging that the reviewer sent work
back, on a task whose reviewer approved it and whose landing failed on the
machine. `Prog.release` therefore clears it alongside `approved`, for every path
that requeues a task.

Approval is a durable `approved` label, not task completion. The reviewer writes
that verdict and stops. Foreman re-checks the checkout, merges, and only then
runs `prog done`. `awaitingLanding` reads that label with no other
corroboration, so any transition handing the task back for its diff to change
must clear it — `Prog.release`, `review` and `submit` all do, and so does
`clearReview`, which is how the settle loop's `ReviewReturned` ends a review:
a reviewer can approve and then return the work in one turn, and the verdict
must not outlive the review that wrote it.

**A landing is proved somewhere disposable before it is applied.** The merge is
made, and the project's `verify` is run, in a per-project proving ground —
`verifyDirectoryFor` in `src/fleet.ts`, a detached git worktree reset to the
checkout's current tip.

**What lands is that commit, not a merge remade from the same parents.** The
ground shares the repository's objects, so the proved commit is addressable from
the checkout, and git fast-forwards onto it. The checkout therefore takes the
exact tree that was verified, and the fast-forward cannot reconcile anything —
which is what makes a refusal there provably about the machine.

Every property that makes this the design follows from the operator sharing that
checkout. A test suite spawns its own processes, and running one in a directory
somebody is using strands the `index.lock` that the landing's own git then trips
over. And the undo disappears entirely: backing a merge out was only ever needed
because the merge had to be applied to be tested, and a `reset --hard` that fails
leaves an unverified merge sitting in the shared checkout with nothing to say so.
The proving ground is reset from the checkout's tip on the next landing anyway,
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

`Held` is also what keeps a verdict alive. It leaves the task in `reviewing` with
its `approved` label, so a later tick lands the same reviewed branch; nothing
about a lock invalidates a diff a reviewer already read.

Landing also runs `verify`. Only a ground that was green and reproducibly went red
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
again. So landing's first question is whether `HEAD` already contains the branch,
and an already-merged one returns `Present`: the task is completed without
merging or verifying. Re-merging is a harmless no-op, but re-verifying is not —
it is a full suite run the whole one-fiber tick waits out, repeated forever for a
task that is done. It is asked ahead of the clean gate, because a checkout that
already has the commits is not going to be written to, and holding there would
strand the task for as long as the operator kept editing.

Landing waits for the reviewer's terminal to stop working (`readyToLand`): it
stays `working` from the moment the verdict is written until the turn ends, and
teardown runs `worktree remove --force` on the directory the reviewer is
standing in.

### The branches are the third source of truth

Every other column comes from the task store, which stops mentioning a branch the
moment its task is closed, reclaimed or deleted — while the commits stay. So
`Repository.branches` reads foreman's refs directly and answers three questions
off one read per project:

- **`merged`** — `HEAD` already contains the tip, so the ref is free to delete.
- **`empty`** — the tip is still on `rev-list --first-parent HEAD`, so nothing
  was ever committed on this branch.
- Neither — the branch holds work the checkout has not taken.

**`merged` cannot stand in for `empty`.** A `by:*` label proves foreman authored
a branch; it does not prove the author wrote anything, and an agent can run
`prog review` having committed nothing. Asking only "is this branch unmerged" and
reading "no" as "nothing was committed" hands finished, merged work back to the
queue as empty. `--no-ff` is what makes the honest question cheap: every landing
is a merge commit, so the first-parent line is exactly the set of commits the
checkout held before any branch touched it.

The sweep is not a step inside landing. Every tick, in every project, the
dispatcher deletes refs that are `merged` **and** whose task no longer appears in
the queue, the claims or the review list — so a branch merged by hand disappears
the same way a landed one does. Both halves are required: sweeping on `merged`
alone deletes the branch of a task still under review, which is the evidence the
next tick needs to tell work from nothing. `--delete` without `--force` is the
backstop, since git refuses to drop commits the checkout does not have. A clean
linked worktree still holding the merged branch is removed first, so a landing
whose teardown failed does not leave the branch pinned forever; one with
uncommitted or untracked work refuses, and the branch waits.

What is left over is **unreviewed**, and `isUnread` is the whole rule: unmerged,
and its task in no status that still reaches an agent. `open`, `in_progress` and
`reviewing` all end with the branch read — the queue resumes it, a claim is
worked or reclaimed, a review reads it — so a queued task with commits behind it
is not abandoned but next in line, and the queue already works oldest first.
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

Two roles run agents: `author` and `review`. Each runs in its own hc terminal
labelled `fm.role`, and a worker's `roles` map is read back from those labels
every tick (`workersOf` in `src/hc.ts`), not from foreman's memory. Every agent
of a task shares one herdr-app tab, so a reviewer opens beside the author it
reads (`placementOf`).

**Only work in progress refuses a dispatch.** A role that is `working` or
`blocked` rejects a second agent, because two agents in one worktree edit over
each other. A *settled* one does not: it has stopped, it is editing nothing, and
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
returned work, the reviewer that stopped without a verdict, and the reviewer
waiting out a held project. The author that handed off is the exception until
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

`Prog` (`src/prog.ts`) is the whole task-store surface. Nothing above that file
builds a `prog` command line.

`Repository` (`src/repository.ts`) answers what foreman needs to know about a
project's git checkout. Nothing above that file runs `git`.

`Quota` (`src/quota.ts`) answers what a provider has left of its allowance.
Nothing above that file knows which endpoint or which client says so.

## Front ends

herdr-web's server publishes every reading to its pages and writes it to
`state.json` (`src/published.ts`), and reads the queue in its own process
(`queueOf` in `src/host.ts`). The herdr-app panel (`herdr/foreman/main.js`)
reads `state.json`, and reads the queue and a task's record through
`foreman queue` and `foreman show` (`src/store-commands.ts`). Both act through
`foreman <action> <id>` and `foreman policy`. Neither runs `prog`. `state.json`
is a view, not a memory: nothing in foreman reads it back.

`src/view.ts` is a total function from a reading (`FleetState`) to rows and the
actions each row takes, with no renderer, which is why its test is plain
assertions. `src/actions.ts` turns an action on a row into a dispatcher command
through `perform`, and `src/commands.ts` exposes each action as a subcommand. A
new action is an entry in `ACTIONS_LIST` and the column tables in
`src/view.ts`, a case in `perform`, and a line in `ACTION_HELP`.

A one-shot command runs `Dispatcher.read` — a tick's observation, acting on
nothing — then finds the row its id keys. It does not talk to the dispatcher:
the world and the policy file are the only channels, so what it changes the
dispatcher reads on its next tick. **Settle, land and tick have no command.**
Landings are serialised by the dispatcher's one fiber over one proving ground
per project; a second process landing races it.

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

Attention combines the exceptional states in urgency order: vanished-worker
decisions, yours, stale reviews, unreviewed branches, orphaned workers, held
projects, and last the spent accounts. Each row keeps its source kind, so
combining their display does not combine their actions.

Every reading carries `observedAt`, when the dispatcher last read the world. A
running tick publishes its reading and *then* works, so its age tells a reader what the
fleet is doing: seconds mean a fleet cycling on its poll interval; minutes mean a
tick is inside something long, usually a landing running a test suite. Without
it a working fleet and a wedged one look identical.

Each source kind allows only the actions that make sense there, and `perform`
refuses an action the row cannot take. Decisions are named from the task's
status, not its labels: a failed spawn leaves the `by:*` label on a task that
sits back in the queue, and only the status — neither claimed nor under review —
marks its worker as residue.

The two corrections follow the labels, not the views. `descend` takes back one
recorded failure, because a rung is only ever as good as the evidence that wrote
it and a bug, an OOM or a killed run all write one nothing earned; one step per
call, unwriting exactly the `failed-by:*` label foreman itself would have
written, and with nothing recorded there is nothing to take back. `unassign` clears a
`review-by:*` label no reviewer is behind — the world records whether a reviewer
was dispatched, not whether it is still alive, so only the operator can say the
label is stale. Both write exactly what foreman itself would have written.

`intervene` acts rather than silently editing a rung. Continue stops the live role,
preserves its worktree and uncommitted edits, and dispatches the rung the
operator names. Diagnose and Review are offered only where git or a surviving
worktree proves an attempt left work. Committed Review uses the formal verdict
pipeline; uncommitted Review and Diagnose run a chosen diagnostic agent, which
may fix trivia and logs findings before foreman resumes the original rung.
`diagnosing:*` is the durable marker that makes this survive a restart; no
in-process intervention state exists.

`yours` takes no answer action. A task waits there because a question about it is
unanswered, and one action to requeue it would hand the next agent that same
question — the failure the column exists to prevent. A task there for the
durable reason leaves when the operator writes the decision into it and removes
its `needs-you` label; one there because evidence exhausted the ladder leaves
when a rung is added or a failure is taken back. The two corrections do reach it,
since a task parked at the operator is exactly the sort of rung that can turn out
not to have been earned.

## Traps

- **Do not start a second herdr-web server to check that it starts.** It hosts
  a dispatcher that reads your policy file and open spaces, so it dispatches live
  agents against the real backlog within one tick wherever the policy allows,
  and races the running one's landings. Typecheck instead; for a live run,
  follow `e2e/README.md`. A smoke test's tasks enter the live queue whenever a
  herdr-app space is open on its project.
- **A reader of stdout alone sees a refusal as success.** hc and prog report a
  failure on stderr with a non-zero exit. `exec` in `src/hc.ts` and `run` in
  `src/prog.ts` collect the exit code and both streams; a new adapter must too.
- **Module resolution breaks outside the project directory.** Scratch scripts
  that import `./src/*` must live in the repo root.
- **Landing belongs to foreman, not the reviewer.** The reviewer records an
  `approved` label. Foreman owns the clean-checkout gate, merge, verification and
  `prog done`.

## House rules

- Never patch around a wall. No flags, special cases, conversion shims, or
  parallel paths to make a broken design compile. The bugs above were fixed by
  deleting a concept, not adding one. Report a blocker instead.
- Use `prog` for task tracking. The epic is `ep-0e6a7e`.
- Bun, not node. Effect-TS throughout.
- Edit only foreman, `~/build/server-ansible` and this machine's `~/.config/foreman/`. When a sweep reaches another project, list those files and file the work with `prog -p <project> add`.
- **A gap in hc or herdr-app is a task in `amux`, not a workaround here.**
  Foreman is their heaviest user, so it finds the missing capabilities first,
  and the cost of each is a shim here encoding what hc should have told us. File
  it with `prog -p amux add` describing the capability rather than the symptom,
  and say in the foreman task that it is blocked on it.
