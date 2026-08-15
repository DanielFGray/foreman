# Working on foreman

Read this before you touch the code. The README says what foreman does; this
says where it currently is, why it is shaped the way it is, and which walls
have already been hit so you do not walk into them again.

## Status: compiles

The derived-state rewrite is finished; `tsc --noEmit` and `oxlint` diagnostics
are all clean. The tree is one `Dispatcher` service over `Fleet` and `Prog`,
with `main.ts` as the only entry point. `src/worktree.ts` is gone — herdr owns
worktrees, and `labelFor` in `src/fleet.ts` is the single name for `foreman/<task>`.

The layer set in `main.ts` is deliberately `Layer.provideMerge(Dispatcher.Default,
base)`: `Dispatcher.Default` pulls in `Prog` and `Prompts` as its own
dependencies, and the base set feeds it `Settings` and `Fleet`. `mergeAll`
alone would build them in parallel and never satisfy that.

The author → review → merge pipeline has been proven live once, end to end, at
`--slots 1`. The proof ran against a scratch project (`foreman-e2e-probe`) with
a scratch config, so no real task was touched. The rig is checked in at
`e2e/` — read `e2e/README.md` before running it. Everything that follows is
the still-unproven backlog.

- **The dashboard is built but unproven live.** It is only proven by the
  render tests; nobody has yet sat in front of it while the fleet worked.
- **Plan mode has been proven live end to end, at the tasker's worst model.**
  A full `foreman plan --file` run on a scratch project
  (`foreman-e2e-probe`, config `FOREMAN_CONFIG=<a scratch config>`) ran
  planner → tasker → opened children on 2026-08-14, with the tasker at
  deepseek-flash (the model that filed epics in the original bug): two tasks
  filed under the epic with `--parent`, dependency wired, the unblocked child
  in `prog ready`, workspace closed. The resume path was proven only in its
  closed state (`plan --epic` on a done epic reports complete without
  re-running); a mid-planning or mid-tasking resume is still unproven. The
  proof did not touch the real backlog.

## The design, and why

### Foreman remembers nothing

The first version held a `Ref<Map<string, Assignment>>`. That map was the only
record of what foreman was doing, so every restart orphaned the whole fleet:
tasks stayed claimed, panes stayed open, and nothing could tell foreman's own
work from a claim made by hand. Every session ended in manual cleanup.

So the world is authoritative, not the process:

| Question | Answered by |
| --- | --- |
| What am I working on? | herdr workspaces labelled `foreman/<task-id>` |
| Who authored this branch? | the task's `by-<rung>` label |
| Is a reviewer already assigned? | the task's `review-by-<rung>` label |
| Which rung does this task get next? | the task's `rung-<name>` label |
| Is this one waiting on a person? | its rung names no configured model |
| Is this task mine to review? | it has a `by-*` label |
| Is this project free to work in? | `git status` in its checkout |

Every tick reads all of it back. A restart re-adopts its live workspaces
instead of orphaning them — that is what `Fleet.open` returning an existing
workspace by label is for. The only thing foreman genuinely cannot derive is
whether the operator has paused dispatch, because nothing in the world records
an intention. That is the one `Ref`, and it starts paused unless `--running`
says otherwise: settling and reclaiming run regardless, so a fresh start lands
finished work and tidies dead workspaces before it asks for anything new.

`--running` exists because a restart is not an operator. Under `bun --watch` the
daemon restarts whenever foreman's own source changes, and landing a task into
foreman's own checkout does exactly that — so pausing by default parked the
fleet after every landing and waited for a person. The command line is the only
thing a restart inherits, which is why the intention is stated there and nowhere
durable. Writing it to disk would make foreman remember, and the operator's last
keypress is not a fact about the world.

The wake queue beside it is not a second one. It holds no state — a tick reads
everything back either way — it only says "look now" so an operator's keypress
does not wait out the poll interval. Every command on the dispatcher goes
through `commanded`, which nudges it.

**If you find yourself adding a second one, stop.** It means something the
world should be recording is not being recorded, and the fix belongs in herdr
or prog, not in a field on the dispatcher.

### One workspace per task

`foreman/<task-id>` is the workspace label and git branch. It cannot also be the
herdr agent name: agent names reject `/`, and author/reviewer output panes
coexist. Agents therefore use ephemeral names derived from their unique pane;
the workspace label remains the durable task identity that other processes
read.

The author runs in the workspace's own pane; only the reviewer splits a second
pane beside the author's output. One task is one pane, so the operator never
sees a blank shell beside a worker. The author's output stays visible after it
settles; the reviewer reads the diff next to it. The workspace dies when the
task leaves the fleet.

The label records no ownership, and the roster is every daemon's: herdr shows
all of them, and two foremen against different configs are not competing for
the same slots. The config's project set is the only ownership the world
records, so `scopeRoster` in `src/dispatcher.ts` scopes what each daemon may
act on — the busy count, settle, the dashboard — to workspaces whose task
lives in a project it manages.

### herdr owns the worktree

It has to. foreman used to create the worktree with `git worktree add` and then
ask herdr to split a pane, and every worker landed in whichever window happened
to be focused — because herdr had never been told the two were related.
`herdr worktree create` makes the worktree, the branch, the workspace and its
label in one call, and returns all four ids.

This is why `src/worktree.ts` is gone: the code foreman used to need for
creating worktrees was deleted rather than fixed, because the concern moved
wholly into herdr.

### A vanished worker is not a verdict

herdr reports `unknown` for a workspace with no agent running. That covers an
agent that exited cleanly **and** a pane a human closed to take over, and herdr
cannot tell them apart — so neither does foreman.

An earlier version treated it as failure and escalated the task to the frontier
model. Closing a pane to stop a run therefore spent money on the next one. That
path is deleted. A vanished worker now becomes a **decision** in `FleetState`,
surfaced in the dashboard, and the task stays claimed until someone answers.
After `staleAfterHours` of no activity the claim is released with a log line.

Absence is an unknown, not evidence. A task still climbs a rung on real
evidence: an agent that settled without finishing, a reviewer sending work back,
or a branch that would not land.

An author that settled without finishing is still running idle, and herdr has no
way to stop it without closing the pane it runs in — which, for an author, is
the workspace's own pane. So that settle closes the workspace: the worktree is
removed with it, the commits on the branch survive, and the next author opens
from the branch tip rather than from uncommitted edits.

### The operator's checkout is shared, so it is asked about

Every task ends by merging into the project's main checkout — the one the
operator edits in. `Repository.isClean` is the whole answer: a project with
uncommitted changes to tracked files is **held**, and `fill` passes over its
tasks in both the review and the author pass. It is read every tick like
everything else, so a project frees itself the moment the tree is clean.

Tracked changes only, deliberately. Untracked files are scratch notes and build
output that live in a repository for months, and counting them would hold a
project forever.

A checkout with no branch is held too, and that clause was written in blood. The
branch a landing moves is whichever one `HEAD` names, and `git merge` into a
detached `HEAD` succeeds: the commits land, the operator's branch stays where it
was, and the tick sweep then deletes the only ref that reached them. Foreman did
exactly that to a reviewed task. "Free to work against" therefore means both
that nobody is mid-edit **and** that there is a branch for the work to land on.

### jj checkouts land through jj

Most of these projects are jj colocated with git, and jj is not a variation on
the git path — it answers both of those questions differently:

- **There is no checked-out branch.** jj bookmarks do not move by being merged
  into. The bookmark to land on is derived the way git derives it — the branch
  the operator is standing on, which here is the nearest bookmark behind the
  working copy, `heads(::@ & bookmarks())`. `heads` drops the bookmarks already
  merged into that one, and foreman's own names are filtered out of what is
  left: every author branches from the trunk's tip, so until that author commits
  its bookmark sits on the very commit being asked about. Reading it as a second
  candidate held the project for as long as anyone was working in it — a fleet
  that stops landing the moment it starts working. Of the bookmarks that remain,
  zero or more than one holds the project rather than guessing.
- **The working copy is a commit**, so "clean" is `@` being empty. That counts a
  file git would call untracked, unlike the git path above, because under jj it
  is not untracked: it is already part of the working-copy commit, and landing
  would carry it out of the operator's directory.
- **jj never refuses a merge.** A conflict is a recorded state with markers
  written into the files, so the conflict check is the ordinary path rather than
  an error path, and backing out is `edit` then `abandon` rather than an abort.

Everything else stays on git. The refs and worktrees in a colocated repository
are real, `git for-each-ref` reads them correctly, and `git branch --delete`
keeps the refusal that makes the sweep safe — a colocated jj imports git's refs
at the start of every command, so a branch deleted there is a bookmark gone
here. `Repository` reads which kind of checkout it has from the directory, per
call, like everything else foreman knows.

The dispatch gate cannot be the only gate: a tree can go dirty hours after an
agent starts. Both prompt templates therefore run the same `git status
--porcelain --untracked-files=no` immediately before merging, and on output they
leave the branch, log why, and `prog open` the task. Foreman then holds that
project until you are done, and the next agent continues from the branch.

An unreadable repository counts as held. Foreman cannot merge into a checkout it
cannot read either, so the failure is not a reason to proceed.

### Onboarding is the one agent inside the operator's checkout

A held project is unheld by salvaging what is in it. `Dispatcher.onboard` files a
task in that project, calls `Fleet.attach` for a workspace on the checkout
itself, and runs `prompts/onboard.md` at the top rung of the ladder. Reading a
hundred files of abandoned work and inferring what somebody meant is the
judgement cheap models are worst at, and this runs once per project rather than
once per task.

Three things hold it together, and each of them has a reason:

- **`Fleet.attach`, not `Fleet.open`.** The work exists only in that checkout. A
  worktree would hand the agent a copy of the last commit — the one state that
  contains none of what it was sent to find.
- **`Worker.worktree` decides teardown.** `workspace close` leaves a worktree on
  disk and registered with git; `worktree remove` refuses on an attached
  workspace and leaves the workspace open. Neither is a superset, so `close`
  reads which kind it has. That field comes from herdr's own workspace record
  every tick — deriving it from foreman's memory is how you eventually delete
  somebody's work.
- **The `onboard` label keeps it out of the queue.** The queue is work the fleet
  may start by itself, and this stands in a directory a person is using. The
  label survives a failed attempt, so a released salvage task never gets picked
  up as ordinary work — and `retry` routes it back through `dispatchOnboard`
  rather than sending an author into a worktree.

The prompt forbids `stash`, `reset`, `checkout -- <file>` and `clean` by name,
and ends by returning the operator's branch to its previous tip. Read it before
changing anything about this path.

### Plan mode is the front half of the pipeline

`foreman plan` turns a rough plan into tasks, so the backlog does not have to be
filled by hand. A plan is an epic in prog labelled `plan`, created in draft; the
planner agent writes the specification into the epic's description; the tasker
agent files the specification as children, wires `prog blocks`, opens them only
once the deps are complete, and runs `prog done`. The stages follow the epic's
derived status: a plan is a draft until it has child tasks, so the tasker's
children are what move it out of draft, and the tasker's `prog done` closes it.

Four decisions shape it, and each has a reason:

- **The spec lives in the task store, not the repository.** The fleet's authors
  read `prog show ep-...` for the spec a generated task references, the same way
  they read a task's description. Nothing about a plan dirties the operator's
  checkout or leaves a git footprint, and the plan survives a restart because
  prog owns it.
- **Plan runs are synchronous and self-contained.** `src/plan.ts` is its own
  process that drives both agents and closes the workspace. The daemon has zero
  plan awareness on purpose: an epic is never claimed, never `in_progress`, and
  never in `prog ready` (draft and epics are both filtered by prog itself), so
  the dispatcher ignores the plan while picking up its opened children as
  ordinary reviewed work. If a plan needs the daemon, the design is wrong.
- **Stages are sequenced by what agents leave in the store, never by watching
  them.** `prog show` returns an epic's *derived* status, which is a draft until
  the first child task exists — so the planner's deliverable is the
  specification it writes into the description, and the tasker's children are
  the transition that moves the epic out of draft. `foreman plan --epic ep-...`
  resumes exactly where a run stopped: an epic with no children replans, one
  with children re-tasks, and a closed one stays done.
- **The planner may interrupt the operator.** It interviews through its question
  tool, one question at a time, only when the plan and codebase genuinely cannot
  decide something. This is the one place an unattended foreman agent is told to
  ask; everything else decides and records.

Generated tasks are ordinary work: `--priority 2`, so the fleet reviews them
like anything it authored. The `plan` label stays on the epic only; it is what a
resume validates against.

### Order inside a tick

Settle, reclaim, then fill — and **reviews are filled before new work**. A task
awaiting review is nearly finished and is blocking whatever depends on it,
whereas an unclaimed task has not started costing anything. Filling slots with
new work while reviews pile up grows a permanent tail of almost-done tasks.

### The review gate

`reviewing` is a status anything can set. There are tasks in the backlog that
have sat in `reviewing` since before foreman existed, with no branch behind
them. Dispatching a reviewer to one gives it no diff to read and nothing to
merge; it will invent something.

A task is foreman's to review only if it carries a `by-*` label — which foreman
writes when an agent actually starts. Do not weaken this into "has a
workspace": the workspace can legitimately be absent while the label is not.

`reviewing` also does not say whether a reviewer was dispatched: it covers both
the author's completed handoff and the whole review run. `review-by-*` records
the latter. If that label exists and the worker vanishes, the dashboard must ask
instead of silently launching another reviewer.

`reviewing` means the author stopped writing, not that a reviewer must read the
diff. Work that skips review (priority 3, or the `trivial` label) waits in that
same status and is landed straight from it. Landing is the only code path that
writes to the operator's checkout, so no prompt gives an agent merge rights.

Approval is a durable `approved` label, not task completion. The reviewer writes
that verdict and stops. Foreman re-checks the operator's checkout, merges the
branch, and only then runs `prog done`. A dirty checkout leaves the verdict in
place for a later tick. A failed merge is aborted and returned to the queue, so
the mechanical landing step cannot strand the operator in a conflicted checkout.

Landing also runs the project's `verify` command, once before the merge and once
after. Only a checkout that was green and went red is the branch's fault: that
merge is reset away, the output is logged, and the task returns to the queue. A
checkout that was already red still accepts the merge, because a branch cannot be
blamed for damage that predates it and one broken test would otherwise freeze the
whole fleet. A project that names no `verify` lands on git's exit code alone, and
the task log says so.

Landing waits for the reviewer's pane to stop working. The pane stays `working`
from the moment the verdict is written until the turn ends, and closing the
workspace runs `worktree remove --force` on the directory the reviewer is
standing in.

### The branches are the third source of truth

Every column but this one comes from the task store, which stops mentioning a
branch the moment its task is closed, reclaimed or deleted — while the commits
stay on the branch. So `Repository.branches` reads foreman's refs directly, and
answers three questions off one read of each project:

- **`merged`** — `HEAD` already contains the tip, so the ref is free to delete.
- **`empty`** — the tip is still on `rev-list --first-parent HEAD`, so nothing
  was ever committed on this branch.
- Neither — the branch holds work the checkout has not taken.

`merged` cannot stand in for `empty`, and confusing the two cost a landed task.
A `by-*` label proves foreman authored a branch; it does not prove the author
wrote anything, and an agent can run `prog review` having committed nothing. The
old code asked only "is this branch unmerged", and read "no" as "the author
committed nothing" — but a branch that just landed answers "no" for the opposite
reason. Foreman handed finished, merged work back to the queue as empty.
`--no-ff` is what makes the honest question cheap: every landing is a merge
commit, so the first-parent line is exactly the set of commits the checkout held
before any branch touched it, and a tip still sitting on it never had a commit
of its own.

The sweep is not a step inside landing. Every tick, in every project, the
dispatcher deletes the refs that are `merged` **and** whose task no longer
appears in the queue, the claims or the review list — so a branch merged by hand
disappears the same way a landed one does, and nothing has to remember what it
merged. Both halves are required: sweeping on `merged` alone deletes the branch
of a task still under review, which is the evidence the next tick needs to tell
work from nothing. `--delete` without `--force` is the backstop — git refuses to
drop commits the checkout does not have, and refuses a branch a worktree still
holds, which is picked up on a later tick.

What is left over — unmerged, not empty, and unaccounted for by any task — is
stranded. `s` sends the selected one back to `reviewing`, where a reviewer
decides whether the commits are worth landing. A branch whose task was deleted
has no id to dispatch against, so it is listed and left alone.

### Roles are panes

Four roles run agents: `author`, `review`, `planner`, `tasker`. A workspace
carries a `roles` map of the ones it currently has, keyed by that literal, and
each is read back from a pane labelled `foreman-<role>` — herdr's own record,
not foreman's memory.

Placement follows from the label. A role takes the workspace's own pane if it is
unlabelled; otherwise it splits a new one. So the first author owns the workspace
pane, a reviewer splits beside it, and plan mode's two stages take one pane each
in sequence.

One role per pane is also what makes a stage handoff possible. herdr has no
command that ends an agent without closing the pane it runs in, so a planner and
a tasker sharing one pane could never both run; as two roles they simply do not
contend.

**Only work in progress refuses a dispatch.** A role that is `working` or
`blocked` rejects a second agent, because two agents in one worktree edit over
each other. A *settled* one does not: it has stopped, it is editing nothing, and
because herdr cannot end an agent without closing its pane, nothing will ever end
it. Reading settled as live made every workspace foreman deliberately keeps — a
reviewer that returned work with `prog open`, a vanished author's edits — into a
permanent stall: the dispatch is refused, the caller hands the claim back, the
queue offers the task again, and the same refusal repeats every poll forever.
Captured live at one failure every eleven seconds for four minutes until the
daemon was stopped.

So a pane already carrying a role is never reused, not even by the same role. The
replacement splits first and the spent pane is closed after — that order is what
ends the settled agent inside it, and what keeps the workspace alive when the
spent pane is its only one.

Workspace `agent_status` is an attention aggregate, not an operational one: an
unseen old `done` pane outranks current `working` work. `HerdrFleet.roster`
therefore aggregates pane statuses itself.

## Ports

`Fleet` (`src/fleet.ts`) is the whole multiplexer surface — seven methods. herdr
is one implementation; an amux plugin would be a second, not a rewrite.

`Prog` (`src/prog.ts`) is the whole task-store surface. Nothing above that file
builds a `prog` command line. Replacing prog with an in-house store means
writing another implementation of those methods and nothing else.

`Repository` (`src/repository.ts`) answers one question about a project's git
checkout: is the operator working in it. Nothing above that file runs `git`.

**prog itself is not ours.** It is Byron's. Keep edits there minimal and file
in-house replacements in the backlog rather than patching it.

## The dashboard

Built over `Dispatcher.state`, a `SubscriptionRef<FleetState>`. `src/pipeline.tsx`
is the view; `src/dashboard.tsx` owns the renderer's lifetime and forks each
`Controls` command into the dispatcher's runtime. The view is deliberately free
of the dispatcher's own imports — it only reads types and prog helpers — so its
test renders it without dragging in the prompt chain.

The renderer is created inside `Effect.acquireRelease`, and the program parks on
a `Deferred`, because `render` from `@opentui/solid` resolves after mount, not
on exit.

One cursor walks eight columns — queue | working | review | landed, then the
decisions, yours, held and stranded panels. Each column allows only the actions that
make sense there, and a key the selected row cannot take is ignored. Decisions
are named from the task's status, not its labels: a failed spawn leaves the
`by-*` label on a task that sits back in the queue, and only the status —
neither claimed nor under review — marks its workspace as residue. The three
kinds answer differently: a vanished author or reviewer can be retried, taken
over, or released, while an orphaned workspace is only ever closed.

The two corrections follow the labels, not the columns. `x` lowers a task one
rung, the mirror of `e` climb: a rung is only ever as good as the evidence that
wrote it, and a bug, an OOM or a killed run all write a rung nothing earned.
One step per press, writing the same `rung-*` label the ladder reads; off the
bottom rung the label is removed, because the ladder reads no label as the
bottom. `u` clears a `review-by-*` label no reviewer is behind. The world
records whether a reviewer was dispatched, not whether it is still alive, so
only the operator can say the label is stale — a task that is open with a
`review-by-*` label and no live reviewer behind it is stale by definition. Both
keys write exactly what foreman itself would have written, so the result is the
same state a hand-corrected task would be in.

`yours` takes no answer key. A task waits there because a question about it is
unanswered, and one key to requeue it would hand the next agent that same
question — the failure the column exists to prevent. It leaves when the operator
writes the decision into the task and removes its `rung-human` label, with prog.
The two corrections do reach it: a task parked at the operator is exactly the
sort of rung that can turn out to have been written without being earned, and no
other column shows a `rung-human` task to lower it from.

Two divergences from the settled design, walls hit while building:

- **No cancel.** `Dispatcher` has pause, resume, focus, retry, release, close,
  climb, descend, unassign and onboard, but no command cancels a task. "Act on
  a task" means climb or descend; a cancel command belongs on the dispatcher.
- **No focus scope.** The focus control jumps to a worker's pane. Making a
  focused scope read differently — the label, pause-on-scope-completion — is a
  separate task.

## Things that have already cost an afternoon

- **`src/log.ts` must use `Logger.replace`, not `Logger.add`.** The doubling
  that once made `Logger.add` look right was a symptom of the opposite problem.
  Creating an opentui renderer assigns a *new* object to `globalThis.console`
  and routes it to the F12 overlay; Effect resolved the old object when it
  loaded and keeps that reference, so a default logger left in place goes on
  writing to the real stdout — underneath a full-screen renderer, scribbling
  log lines across the dashboard until the next repaint. Captured live on the
  running fleet: `running · 0 awaiting a decision[10:20:32.517] INFO (#42):
  dispatched ts-c74234`. Replacing the default and reading `globalThis.console`
  per line follows the swap instead, and needs no mode flag: under the
  dashboard the line lands in the overlay, and in plan mode, where nothing ever
  swapped the console, on the terminal.
- **Do not run `bun src/main.ts` to "check that it starts".** It dispatches
  live agents against the real backlog within one tick. Two verification runs
  claimed real tasks and had to be unwound by hand. Typecheck instead; when you
  do need a live run, use `--slots 1` and watch it. The same caution covers
  `bun src/main.ts plan ...`: it spawns real planner and tasker agents in panes,
  so a smoke test must target a scratch project that is not in the config —
  otherwise the opened children go straight into the live queue.
- **Plan epics are drafts and must stay drafts.** The whole "daemon needs no
  plan awareness" property rests on the epic never being claimed or moved to
  `in_progress`; the settle loop treats a settled workspace on an `in_progress`
  item as an unfinished agent and would climb and release it. `prog open` on an
  epic is refused, and its derived status is a draft until children exist — the
  planner can never move the epic itself. The tasker's `prog done` is the only
  stored transition in a plan's life.
- **herdr answers on two streams, and a reader of one sees silence.** Results
  come back as a JSON envelope on stdout; failures come back as a JSON envelope
  on stderr with a non-zero exit. `CommandExecutor.string` reads stdout and
  ignores the exit status, so every refusal read as an empty success — foreman
  dispatched agents that never got a prompt, then claimed and labelled their
  tasks. `exec` in `src/herdr.ts` now collects the exit code and both streams,
  and `errorOf` looks for the envelope in either.
- **A cold agent refuses its first prompt.** `herdr agent start` reports
  `interactive_ready` about three seconds in; opencode does not accept typed
  input until about nine. `agent prompt --wait` has a hard 5000 ms floor for the
  first observed state change that `--timeout` can only shorten, so the first
  prompt always comes back `agent_prompt_stalled`. `prompt` retries that code —
  do not replace it with a sleep, because the real wait varies by agent.
- **Module resolution breaks outside the project directory.** Scratch scripts
  that import `./src/*` must live in the repo root, not in a temp directory.
- **Landing belongs to foreman, not the reviewer.** The reviewer records an
  `approved` label. Foreman owns the clean-checkout gate, merge, verification and
  `prog done`, so reviewer agents need no rights over the operator's checkout.

## House rules that bite here

- Never patch around a wall. No flags, special cases, conversion shims, or
  parallel paths to make a broken design compile. The two bugs above were both
  fixed by deleting a concept, not by adding one. Report a blocker instead.
- Use `prog` for task tracking. The epic is `ep-0e6a7e`.
- Bun, not node. Effect-TS throughout.
