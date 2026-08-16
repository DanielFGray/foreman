# Working on foreman

The README says what foreman does. This says why it is shaped the way it is, and
which walls are already known so you do not walk into them again.

Keep it that way. This file is loaded into every session and read by every agent
the fleet dispatches, so its length is a cost paid on every turn. Record the
constraint and the reason it exists — never the incident that revealed it. No
dates, no task ids as evidence, no counts, no proof-run narration.

## Status

The tree is one `Dispatcher` service over `Fleet`, `Prog` and `Repository`, with
`main.ts` as the only entry point.

Proven live: the author → review → merge pipeline end to end, the dashboard
against a real fleet, and plan mode at the tasker's worst model. The rig is in
`e2e/` — read `e2e/README.md` before running it.

Unproven: resuming a plan run that stopped mid-planning or mid-tasking. Only the
closed state is proven, where `plan --epic` on a done epic reports complete.

The layer set in `main.ts` is `Layer.provideMerge(Dispatcher.Default, base)`.
`Dispatcher.Default` pulls in `Prog` and `Prompts` itself, and the base set feeds
it `Settings` and `Fleet`; `mergeAll` builds them in parallel and cannot satisfy
that.

## The design, and why

### Foreman remembers nothing

The world is authoritative, not the process. A dispatcher whose memory is
authoritative loses the fleet on every restart: tasks stay claimed, panes stay
open, and nothing can tell foreman's own work from a claim made by hand.

| Question | Answered by |
| --- | --- |
| What am I working on? | the worktree git has registered for `foreman/<task-id>` |
| Who authored this branch? | the task's `by-<rung>` label |
| Is a reviewer assigned? | the task's `review-by-<rung>` label |
| Which rung comes next? | the task's `rung-<name>` label |
| Is this one waiting on a person? | its rung names no configured model |
| Is this task mine to review? | it has a `by-*` label |
| Is this project free to work in? | `git status` in its checkout |

Every tick reads all of it back, so a restart re-adopts its live workspaces
instead of orphaning them. The only thing foreman cannot derive is whether the
operator has paused dispatch, because nothing in the world records an intention.
That is the one `Ref`. A paused tick observes and reports; settle, tidy, reclaim
and fill wait for resume.

It starts paused unless `--running` says otherwise, because a restart is not an
operator — under `bun --watch` the daemon restarts whenever its own source
changes, which landing a task into foreman's own checkout does. The command line
is the only thing a restart inherits, which is why the intention is stated there
and nowhere durable. Writing it to disk would make foreman remember.

The wake queue beside it is not a second memory. It holds no state — a tick
reads everything back either way — it only says "look now" so a keypress does
not wait out the poll interval. Every dispatcher command goes through
`commanded`, which nudges it.

**If you find yourself adding durable state, stop.** It means something the world
should record is not being recorded, and the fix belongs in herdr or prog.

### One workspace per task

`foreman/<task-id>` is the workspace label and the git branch. It cannot also be
the herdr agent name: agent names reject `/`, and author and reviewer panes
coexist. Agents use ephemeral names derived from their pane; the branch is the
durable identity other processes read.

The worktree, not the workspace, is where the work lives. A workspace is a view
onto it and evaporates when its last pane closes — a keypress can destroy it —
while the worktree and branch survive. `Fleet.open` therefore resolves in order:
a workspace carrying the label, else a worktree git still has registered for the
branch, else creating both. Teardown reads the same order, so a worktree whose
workspace already closed is removed rather than orphaned.

The label records no ownership, and the roster is every daemon's. The config's
project set is the only ownership the world records, so `scopeRoster` in
`src/dispatcher.ts` scopes what each daemon may act on.

### herdr owns the worktree

`herdr worktree create` makes the worktree, the branch, the workspace and its
label in one call. Foreman used to create the worktree itself and then ask for a
pane, and herdr — never told the two were related — put every worker in whichever
window happened to be focused. `src/worktree.ts` is gone rather than fixed,
because the concern moved wholly into herdr.

### A vanished worker is not a verdict

herdr reports `unknown` for a workspace with no agent running. That covers an
agent that exited cleanly **and** a pane a human closed to take over, and herdr
cannot tell them apart — so neither does foreman. Treating it as failure means
closing a pane to stop a run spends money on the next rung.

A vanished worker becomes a **decision** in `FleetState`, surfaced in the
dashboard, and the task stays claimed until someone answers. After
`staleAfterHours` of no activity the claim is released with a log line.

Absence is an unknown, not evidence. A task climbs a rung on real evidence only:
an agent that settled without finishing, a reviewer sending work back, or a
branch that would not land.

### The operator's checkout is shared, so it is asked about

Every task ends by merging into the project's main checkout, the one the operator
edits in. `Repository.isClean` is the whole answer: a project with uncommitted
changes to tracked files is **held**, and `fill` passes over its tasks in both
the review and the author pass. It is read every tick, so a project frees itself
the moment the tree is clean.

Tracked changes only. Untracked files are scratch notes and build output that
live in a repository for months, and counting them would hold a project forever.

A checkout with no branch is held too. The branch a landing moves is whichever
one `HEAD` names, and `git merge` into a detached `HEAD` succeeds: the commits
land, the operator's branch stays put, and the tick sweep then deletes the only
ref that reached them. "Free to work against" means both that nobody is mid-edit
**and** that there is a branch for the work to land on.

An unreadable repository counts as held — foreman cannot merge into a checkout it
cannot read either.

The dispatch gate cannot be the only gate, because a tree can go dirty in the
hours between an agent starting and its branch being ready. `Repository.merge`
asks the same question again as its first act and returns `Held`: the landing is
not attempted, the verdict stays on the task, and a later tick lands it. No
prompt is involved, because no agent merges.

Agents stay out of that checkout entirely. `git` commands there refresh the
index, which collides with a landing mid-merge and leaves `index.lock` behind;
foreman's own reads set `GIT_OPTIONAL_LOCKS=0`, and an agent's cannot be made to.
`Repository.base` resolves a branch's fork point so a reviewer can diff
`<base>..HEAD` inside its own worktree. Onboarding is the one exception, and only
ever on a project already held.

### jj checkouts land through jj

Most of these projects are jj colocated with git, and jj answers both gate
questions differently:

- **There is no checked-out branch.** jj bookmarks do not move by being merged
  into. The bookmark to land on is the nearest one behind the working copy,
  `heads(::@ & bookmarks())`. `heads` drops bookmarks already merged into that
  one, and foreman's own names are filtered out of what remains: every author
  branches from the trunk's tip, so until it commits its bookmark sits on the
  very commit being asked about, and counting it would hold the project for as
  long as anyone is working in it. Zero or more than one candidate holds the
  project rather than guessing.
- **The working copy is a commit**, so clean means `@` is empty. That counts a
  file git would call untracked, because under jj it is already part of the
  working-copy commit and landing would carry it out of the operator's directory.
- **jj never refuses a merge.** A conflict is a recorded state with markers
  written into the files, so the conflict check is the ordinary path rather than
  an error path, and backing out is `edit` then `abandon` rather than an abort.
- **A landing interrupted before the bookmark moves leaves an anonymous head.**
  `jj new` writes the merged files into the working copy, which is what restarts
  a daemon watching its own checkout; only `bookmark set` publishes. So the
  tick sweeps anonymous heads that carry foreman's own landing signature — a
  clean merge of two parents whose description is the one `merge` writes. The
  branch still holds the work, so abandoning one re-does the landing honestly
  instead of publishing an unverified merge, and only the working copy is never
  touched, because that is the one anonymous head a person may be standing on.

Everything else stays on git. The refs and worktrees in a colocated repository
are real, and `git branch --delete` keeps the refusal that makes the sweep safe.
`Repository` reads which kind of checkout it has per call.

### Onboarding is the one agent inside the operator's checkout

A held project is unheld by salvaging what is in it. `Dispatcher.onboard` files a
task in that project, calls `Fleet.attach` for a workspace on the checkout
itself, and runs `prompts/onboard.md` at the top rung. Reading abandoned work and
inferring what somebody meant is the judgement cheap models are worst at, and
this runs once per project rather than once per task.

- **`Fleet.attach`, not `Fleet.open`.** The work exists only in that checkout. A
  worktree would hand the agent a copy of the last commit — the one state that
  contains none of what it was sent to find.
- **`Worker.worktree` decides teardown.** `workspace close` leaves a worktree on
  disk and registered with git; `worktree remove` refuses on an attached
  workspace and leaves the workspace open. Neither is a superset, so `close`
  reads which kind it has, from herdr's own record every tick. Deriving it from
  foreman's memory is how you eventually delete somebody's work. It keys on
  `is_linked_worktree`, not on the presence of a checkout path: a workspace
  attached to a checkout that was already there reports a worktree that is not
  linked, and `close` must treat that directory as the operator's.
- **The `onboard` label keeps it out of the queue.** The queue is work the fleet
  may start by itself, and this stands in a directory a person is using. The
  label survives a failed attempt, and `retry` routes it back through
  `dispatchOnboard` rather than sending an author into a worktree.

The prompt forbids `stash`, `reset`, `checkout -- <file>` and `clean` by name,
and ends by returning the operator's branch to its previous tip. Read it before
changing anything about this path.

### Plan mode is the front half of the pipeline

`foreman plan` turns a rough plan into tasks. A plan is an epic in prog labelled
`plan`, created in draft; the planner writes the specification into the epic's
description; the tasker files it as children, wires `prog blocks`, opens them
once their deps are complete, and runs `prog done`.

- **The spec lives in the task store, not the repository.** Authors read
  `prog show ep-...` the same way they read a task's description. Nothing about a
  plan dirties the operator's checkout, and the plan survives a restart.
- **Plan runs are synchronous and self-contained.** `src/plan.ts` drives both
  agents and closes the workspace. The daemon has zero plan awareness: an epic is
  never claimed, never `in_progress`, and never in `prog ready`, so the dispatcher
  ignores the plan while picking up its opened children as ordinary reviewed work.
  If a plan needs the daemon, the design is wrong.
- **Stages are sequenced by what agents leave in the store, never by watching
  them.** `prog show` returns an epic's derived status, a draft until the first
  child exists — so the planner's deliverable is the specification and the
  tasker's children are the transition out of draft. `plan --epic` resumes where
  a run stopped: no children replans, children re-tasks, closed stays done.
- **The planner may interrupt the operator**, through its question tool, one
  question at a time, only when the plan and codebase genuinely cannot decide
  something. This is the one place an unattended foreman agent is told to ask.

Generated tasks are ordinary work at `--priority 2`. The `plan` label stays on
the epic only; it is what a resume validates against.

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
  foreman remembers nothing. So the script must be safe to re-run — which a
  package manager's install already is, and which a clone needs a guard to
  become. Re-running is also what repairs a half-written worktree.
- **The prompts close the loop.** An agent that repairs a worktree by hand is
  told to add the missing step to the script and commit it. That is the ratchet:
  every hand repair converts one non-deterministic step into a deterministic one,
  and the next agent arrives in a worktree that already builds instead of solving
  the same puzzle on its own task's budget.

### Order inside a tick

Settle, reclaim, then fill — and **reviews are filled before new work**. A task
awaiting review is nearly finished and is blocking whatever depends on it,
whereas an unclaimed task has not started costing anything. Filling slots with
new work while reviews pile up grows a permanent tail of almost-done tasks.

### The review gate

`reviewing` is a status anything can set, including tasks that predate foreman
and have no branch behind them. Dispatching a reviewer to one gives it no diff to
read and nothing to merge; it will invent something.

A task is foreman's to review only if it carries a `by-*` label, which foreman
writes when an agent actually starts. **Do not weaken this into "has a
workspace"** — the workspace can legitimately be absent while the label is not.

`reviewing` also does not say whether a reviewer was dispatched: it covers both
the author's completed handoff and the whole review run. `review-by-*` records
the latter, so a vanished worker under that label is a question for the dashboard
rather than grounds for silently launching another reviewer.

Work that skips review — priority 3, or the `trivial` label — waits in that same
status and is landed straight from it. Landing is the only code path that writes
to the operator's checkout, so no prompt gives an agent merge rights.

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
the project's `verify` into the prompt; a project naming none has no landing
gate, and there the full run is the reviewer's after all.

Approval is a durable `approved` label, not task completion. The reviewer writes
that verdict and stops. Foreman re-checks the checkout, merges, and only then
runs `prog done`. `awaitingLanding` reads that label with no other
corroboration, so any transition handing the task back for its diff to change
must clear it — `Prog.release`, `review` and `submit` all do.

**A merge that did not happen and a merge that would not happen are different
answers.** Only the second is about the branch, and only the second may climb a
rung. git exits 1 when it merged and the content would not reconcile; it exits
128 when it never got that far — a lock, a ref it cannot read. Under jj there is
no first case: jj records a conflict rather than refusing one, so the conflict
check is the whole verdict and any non-zero exit is the machine. Everything in
the second class is `Held`, and `Held` carries a `detail` so it is logged — an
operator editing clears itself and is not worth a line every poll, a stale lock
never clears and must not retry in silence.

Landing also runs `verify`. Only a checkout that was green and went red is the
branch's fault: that merge is undone, the output logged, and the task returned to
the queue. A checkout already red still accepts the merge, because a branch
cannot be blamed for damage that predates it and one broken test would otherwise
freeze the whole fleet. A project naming no `verify` lands on git's exit code
alone, and the task log says so.

**The baseline is lazy, and that is not an optimisation.** The merge is applied
first and the merged checkout verified; only if that fails is the pre-merge
baseline worth running, because only then is "was it red already?" a live
question. The tick is one fiber, so a verification run is time in which nothing
else is dispatched, settled or landed, and an eager baseline made every good
landing cost two full suite runs. A failure still costs two, plus re-applying the
merge when the baseline proves the branch innocent. Never worse where it matters,
and half the price in the common case.

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

Landing waits for the reviewer's pane to stop working: it stays `working` from
the moment the verdict is written until the turn ends, and closing the workspace
runs `worktree remove --force` on the directory the reviewer is standing in.

### The branches are the third source of truth

Every other column comes from the task store, which stops mentioning a branch the
moment its task is closed, reclaimed or deleted — while the commits stay. So
`Repository.branches` reads foreman's refs directly and answers three questions
off one read per project:

- **`merged`** — `HEAD` already contains the tip, so the ref is free to delete.
- **`empty`** — the tip is still on `rev-list --first-parent HEAD`, so nothing
  was ever committed on this branch.
- Neither — the branch holds work the checkout has not taken.

**`merged` cannot stand in for `empty`.** A `by-*` label proves foreman authored
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
backstop, since git refuses to drop commits the checkout does not have and
refuses a branch a worktree still holds.

What is left over — unmerged, not empty, unaccounted for by any task — is
stranded. `s` sends the selected one back to `reviewing`. A branch whose task was
deleted has no id to dispatch against, so it is listed and left alone.

### Roles are panes

Four roles run agents: `author`, `review`, `planner`, `tasker`. A workspace
carries a `roles` map keyed by that literal, each read back from a pane labelled
`foreman-<role>` — herdr's record, not foreman's memory.

Placement follows from the label: a role takes the workspace's own pane if it is
unlabelled, otherwise it splits a new one. So the first author owns the workspace
pane, a reviewer splits beside it, and plan mode's two stages take one pane each
in sequence. One role per pane is also what makes a stage handoff possible —
herdr cannot end an agent without closing its pane, so a planner and a tasker
sharing one could never both run.

**Only work in progress refuses a dispatch.** A role that is `working` or
`blocked` rejects a second agent, because two agents in one worktree edit over
each other. A *settled* one does not: it has stopped, it is editing nothing, and
nothing will ever end it. Reading settled as live turns every workspace foreman
deliberately keeps into a permanent stall — the dispatch is refused, the caller
hands the claim back, the queue offers the task again, and the refusal repeats
every poll forever.

So a pane already carrying a role is never reused, not even by the same role. The
replacement splits first and the spent pane is closed after; that order is what
ends the settled agent inside it.

**A settled agent is closed at the settle, not at the next dispatch.** It is
editing nothing and will never work another turn, but it still holds its model's
resident memory — enough of it that a full fleet exhausts this machine. `slots`
does not bound that: `busy` counts `working` and `blocked`, so a settled agent
frees its slot and keeps its process. Each settle path that has already written
its record to the store therefore ends with `stopActiveRole`: the author that
handed off, the reviewer that returned work, the reviewer that stopped without a
verdict, and the reviewer waiting out a held project. What the agent did is in
the task's log, which is where the next one is told to read it.

Closing the workspace's last pane is the intended end of that. The worktree and
its uncommitted edits outlive the workspace and `Fleet.open` re-adopts them.

The one settle deliberately not closed is a **vanished** worker, which has no
pane to close.

Workspace `agent_status` is an attention aggregate, not an operational one: an
unseen old `done` pane outranks current `working` work. `HerdrFleet.roster`
aggregates pane statuses itself.

## Ports

`Fleet` (`src/fleet.ts`) is the whole multiplexer surface — eight methods. herdr
is one implementation; an amux plugin would be a second, not a rewrite.

`Prog` (`src/prog.ts`) is the whole task-store surface. Nothing above that file
builds a `prog` command line.

`Repository` (`src/repository.ts`) answers what foreman needs to know about a
project's git checkout. Nothing above that file runs `git`.

**prog itself is not ours.** It is Byron's. Keep edits there minimal and file
in-house replacements in the backlog rather than patching it.

## The dashboard

Built over `Dispatcher.state`, a `SubscriptionRef<FleetState>`. `src/pipeline.tsx`
is the view; `src/dashboard.tsx` owns the renderer's lifetime and forks each
`Controls` command into the dispatcher's runtime. The view is deliberately free
of the dispatcher's imports — it reads types and prog helpers only — so its test
renders it without dragging in the prompt chain.

The renderer is created inside `Effect.acquireRelease`, and the program parks on
a `Deferred`, because `render` from `@opentui/solid` resolves after mount, not on
exit.

One cursor walks five views — queue | working | review | landed | attention — one
full-width list at a time. Only non-empty views become tabs, so landed history is
a count until selected rather than a permanent column squeezing active work. At
120 columns extra width adds selected-row details; it never restores columns.

Attention combines the exceptional states in urgency order: vanished-worker
decisions, yours, stranded branches, then held projects. Each row keeps its source
kind, so combining their display does not combine their actions. A view that
empties under the cursor hands it to the nearest non-empty tab to its left.
Attention opens when it changes from empty to non-empty, including at startup,
and must clear before a later item can interrupt again.

The status line remains when every view is empty, because an empty fleet still
has to say whether it is paused or merely out of work. It also says how long ago
the dispatcher last read the world — `FleetState.observedAt`, set by `observe`
and aged by the view's own one-second clock, because a tick publishes its reading
and *then* works. Seconds mean a fleet cycling on its poll interval; minutes mean
a tick is inside something long, usually a landing running a test suite. Without
it a working fleet and a wedged one look identical. It is not durable and must not
become so: it describes this process, not the world.

Each source kind allows only the actions that make sense there, and a key the
selected row cannot take is ignored. Decisions are named from the task's status,
not its labels: a failed spawn leaves the `by-*` label on a task that sits back in
the queue, and only the status — neither claimed nor under review — marks its
workspace as residue.

**Residue foreman can prove is spent is swept, not asked about.** Dispatch opens
the workspace, claims the task, and only then spawns the agent that labels the
pane. So a role on an unclaimed task's workspace proves the claim happened and
was given up, and settle closes those panes itself; only a workspace carrying no
role reaches the dashboard as a question, because that is the one case foreman
cannot prove is spent. Panes, not the workspace: what is uncommitted in the
worktree belongs to a returned reviewer or a vanished author, and closing a pane
is the one teardown that cannot lose it.

The two corrections follow the labels, not the views. `x` lowers a task one rung,
because a rung is only ever as good as the evidence that wrote it and a bug, an
OOM or a killed run all write one nothing earned; one step per press, writing the
same `rung-*` label the ladder reads, and off the bottom rung the label is
removed because the ladder reads no label as the bottom. `u` clears a
`review-by-*` label no reviewer is behind — the world records whether a reviewer
was dispatched, not whether it is still alive, so only the operator can say the
label is stale. Both keys write exactly what foreman itself would have written.

`e` intervenes rather than silently editing a rung. Continue stops the live role,
preserves its worktree and uncommitted edits, asks which rung takes over, and
dispatches it. Diagnose and Review are offered only where git or a surviving
worktree proves an attempt left work. Committed Review uses the formal verdict
pipeline; uncommitted Review and Diagnose run a chosen diagnostic agent, which
may fix trivia and logs findings before foreman resumes the original rung.
`diagnosing-*` is the durable marker that makes this survive a restart; no
in-process intervention state exists.

`yours` takes no answer key. A task waits there because a question about it is
unanswered, and one key to requeue it would hand the next agent that same
question — the failure the column exists to prevent. It leaves when the operator
writes the decision into the task and removes its `rung-human` label. The two
corrections do reach it, since a task parked at the operator is exactly the sort
of rung that can turn out not to have been earned.

The wheel moves the cursor, never the viewport. A scrollbox scrolls itself by
default, and that is a second position beside the cursor: one notch carries the
selected row off the screen, and the next keypress snaps the view back. The
listener therefore sits on the scrollbox's *content*, not on the scrollbox. A
mouse event runs a renderable's own listeners, then its built-in handler, then
walks to its parent, so `stopPropagation` only stops the walk — from the content,
the scrollbox is the parent that is never reached, while a listener on the
scrollbox itself could never suppress its own scrolling. Tabs and rows are
clickable; page keys move five rows at a time.

Two divergences from the settled design:

- **No cancel.** `Dispatcher` has pause, resume, focus, retry, release, close,
  climb, descend, unassign and onboard. "Act on a task" means climb or descend; a
  cancel command belongs on the dispatcher.
- **No focus scope.** The focus control jumps to a worker's pane. Making a
  focused scope read differently is a separate task.

## Traps

- **Do not run `bun src/main.ts` to check that it starts.** It dispatches live
  agents against the real backlog within one tick. Typecheck instead; when you
  need a live run, use `--slots 1` and watch it. The same covers
  `bun src/main.ts plan ...`, which spawns real planner and tasker agents — a
  smoke test must target a scratch project outside the config, or its opened
  children go straight into the live queue.
- **`src/log.ts` must use `Logger.replace`, not `Logger.add`.** Creating an
  opentui renderer assigns a *new* object to `globalThis.console` and routes it
  to the F12 overlay. Effect resolved the old object when it loaded and keeps
  that reference, so a default logger left in place writes to the real stdout
  underneath a full-screen renderer. Replacing the default and reading
  `globalThis.console` per line follows the swap, and needs no mode flag.
- **Plan epics are drafts and must stay drafts.** The "daemon needs no plan
  awareness" property rests on the epic never being claimed or moved to
  `in_progress`; the settle loop would read a settled workspace on an
  `in_progress` item as an unfinished agent and climb and release it. The
  tasker's `prog done` is the only stored transition in a plan's life.
- **herdr answers on two streams, and a reader of one sees silence.** Results
  come back as a JSON envelope on stdout; failures come back as an envelope on
  stderr with a non-zero exit. `CommandExecutor.string` reads stdout and ignores
  the exit status, so every refusal reads as an empty success. `exec` in
  `src/herdr.ts` collects the exit code and both streams, and `errorOf` looks for
  the envelope in either.
- **A cold agent refuses its first prompt.** `herdr agent start` reports
  `interactive_ready` about three seconds in; opencode does not accept typed
  input until about nine. `agent prompt --wait` has a hard 5000 ms floor that
  `--timeout` can only shorten, so the first prompt always returns
  `agent_prompt_stalled`. `prompt` retries that code — do not replace it with a
  sleep, because the real wait varies by agent.
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
- **A gap in herdr is a task in `amux`, not a workaround here.** Foreman is
  herdr's heaviest user, so it finds the missing capabilities first, and the cost
  of each is a shim here encoding what herdr should have told us. File it with
  `prog -p amux add` describing the capability rather than the symptom, and say
  in the foreman task that it is blocked on it.
