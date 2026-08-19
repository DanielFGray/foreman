# foreman

A dispatcher for a fleet of coding agents. It watches the agents running in your
multiplexer, and whenever one stops, it claims the next ready task and hands it
over. You stop being the thing that moves work from the backlog into a pane.

```
   prog                  foreman                  herdr
   task store            dispatcher               workspaces you can watch
   ready / claim  <----  poll, claim, prompt ---> worktree, agent, prompt
                         settle, reclaim          roster, focus, close, notify
```

> **Status:** compiles and has focused unit tests. The author → review → merge
> pipeline has been proven live once, end to end, at `--slots 1` against a
> scratch project; see `AGENTS.md` before running it unattended.

## Foreman remembers nothing

What foreman is doing is written in the world, not in the process. Every tick
reads it back: the workspaces herdr is showing, the statuses and labels prog is
holding, the branches git has. Nothing important lives only in memory.

That is what makes it survivable. Kill foreman mid-flight and restart it, and it
re-adopts its live workers instead of orphaning them — a task with a
`foreman/<task-id>` workspace is being worked on, by definition, whoever started
it. It also means anything else can read the same picture: `herdr workspace list`
and `prog list` together tell you everything foreman knows.

## What one tick does

1. **Settle.** Every worker that stopped gets resolved by re-reading its task,
   never by interpreting the agent's output. Landed means notify and close the
   workspace. Unfinished means log why, return the task to the queue with the
   agent's own notes attached, and free the slot. Blocked means notify you and
   change nothing — approvals stay human.
2. **Tidy.** Foreman's merged branches are deleted from every project. `-d`
   refuses anything the checkout does not already have, so only redundant refs
   go. In a jj checkout it also abandons the unpublished merge commits a landing
   interrupted by a restart leaves behind, which is what landing into foreman's
   own checkout under `bun --watch` does.
3. **Reclaim.** A claim with no live worker and no activity for a day goes back
   to the queue. Ownership decides this, not age: a task with a live workspace
   is never touched.
4. **Fill.** Reviews first, then new work. A task awaiting review is nearly
   finished and is blocking whatever depends on it; an unclaimed task has not
   started costing anything yet.

`p` cycles how much work the fleet takes on: **running** → **draining** →
**paused**, and its label names the state it moves to.

Pausing stops all tick mutations. A paused foreman observes and reports, but
does not settle, tidy, reclaim, or fill. Draining is the state in between: it
skips only the new-work half of fill, so reviews, landings and the branch sweep
keep running and the pipeline empties itself instead of freezing with approved
branches unlanded. Drain when you want to aim the fleet by hand.

Foreman starts paused. Opening the dashboard to drain the fleet is the common
case, and it should not be a race against the first tick. Press `p` when you
want it dispatching, or start it with `--running` to skip the keypress. Nothing
else survives a restart: the command line is the only thing that carries over,
so a daemon restarted mid-drain comes back paused.

Use `--running` for anything that restarts by itself. `bun --watch` restarts the
daemon whenever foreman's own source changes — which is what landing a task into
foreman's own checkout does — and the command line is the only thing a restart
carries over.

The poll interval is how long foreman waits to notice something nobody told it
about. Anything you do in the dashboard — drain, pause, retry, release, adopt —
ticks at once, so keys never sit waiting out the clock.

A fresh agent per attempt and review, rather than long-lived workers fed task
after task: no context bleeds between stages or unrelated projects. The author
runs in the task workspace's own pane; only a reviewer splits a second pane
beside it.

## Projects you are working in

A project whose checkout has uncommitted changes to tracked files is **held**:
foreman passes over its tasks and names it in the dashboard, then picks it up
again on the tick after you commit or stash. You share that checkout with the
fleet — every task ends by merging into it — so a dispatch there would move your
branch under you while you edit.

Untracked files do not hold a project. Scratch notes and build output sit in a
repository for months; counting them would hold it forever.

A checkout with no branch is held as well, because a landing has nothing to
move: under git that is a detached `HEAD`, and under jj it is a working copy
with no bookmark behind it.

The held row says which cause it is. An uncommitted change clears itself; a
missing landing target never does, and needs a hand-run command instead.

### jj projects

A project colocated with jj lands through jj. Foreman moves the bookmark you are
standing on — the nearest one behind your working copy — rather than merging
into a branch, because jj has no checked-out branch to merge into. Two things
follow. A working copy that is not empty holds the project, including files git
would call untracked, since jj already counts them as yours. And a conflicting
branch never reaches your directory at all: jj records conflicts instead of
refusing them, so foreman finds them where it proves the merge and returns the
task to the queue.

### Onboarding a held project

A held project can be handed to an agent instead of waiting for you. Pick it in
the dashboard and foreman files a task in that project, opens a workspace on the
checkout itself, and sends the frontier model in to salvage what is there.

It reads the diff and names what the work was doing, runs the project's own
typecheck, tests and linter, and decides each untracked file — a new module the
edits import comes along, scratch output stays. What it keeps is committed to
`foreman/<task-id>`, and then your branch goes back to the commit you left it
on, with a clean tree. The work is one `git checkout` away and your history is
untouched.

The summary lands on the task: what the change was doing, how far it got, what
passes, what it took and what it left. Anything broken becomes its own task in
that project, so the fleet repairs it as ordinary work with review, rather than
one unreviewed agent both salvaging and fixing. The project rejoins the queue as
soon as the tree is clean.

Onboarding runs when you ask, for a held project whose checkout holds
uncommitted work — foreman cannot tell a checkout you stepped away from a
fortnight ago from one you are typing in this minute, and you can. A checkout
held for a missing branch has nothing to salvage, so the dashboard says what to
fix instead of offering the run. The task carries an `onboard` label so the
queue never starts one on its own.

Agents themselves never enter your checkout, with that one exception. Each works in its own worktree
under `$XDG_STATE_HOME/foreman/worktrees/`, on a branch off your current `HEAD`,
and the author prompt forbids touching the main checkout or switching branches.
Landing is foreman's own work, not an agent's, so no prompt anywhere hands out
merge rights. Your tree can go dirty hours after dispatch: foreman re-reads it at
landing time and leaves the finished branch waiting for a tick that finds it
clean.

## One workspace per task

Dispatching a task opens a herdr workspace labelled `foreman/<task-id>`, holding
a git worktree on a branch of the same name. That durable label identifies the
work; ephemeral agents use valid names derived from their pane because herdr
agent names cannot contain `/`.

The author runs in the workspace's own pane, so one task is one pane and there
is no blank shell beside the worker; the reviewer opens a fresh split in the
same workspace, against the same worktree. A pane whose agent has settled is
closed, not left standing: an idle opencode process keeps its model resident at
around 0.7 GiB, so a fleet that never closed one would run out of memory long
before it ran out of slots. The author's pane is the one exception, kept for a
short window after it hands off so a reviewer can send one mechanical finding
back to the session that wrote the code — it closes when that window expires,
or when the review answers. The worktree and anything uncommitted in it outlive
the pane, so the next role picks up where the last one stopped, and the
workspace closes when its last pane does.

A fresh worktree holds committed files only, so the project's dependencies are
not installed in it and every test, typecheck and lint command fails until they
are. Both prompts tell the agent to install them the way the project does.
Foreman does not run the install itself: it cannot know the package manager for
every language, and a table of the JavaScript ones would bias it toward npm
while helping no other ecosystem.

The branch outlives the workspace only as long as it is the only copy of the
work. Every tick deletes foreman's merged branches from each project, so a
landed one goes as soon as its worktree is out of the way — the merge commit
already records it. A rejected or abandoned branch stays, because `git branch
-d` refuses to drop commits the checkout does not have. Nothing decides this
from memory: it is read off the refs each time, so a branch you merge by hand is
cleaned up the same way.

## Unreviewed branches

Work can end up sitting on a branch with nobody on the way to read it. A task
gets reclaimed, or climbs a rung and goes back to the queue, or is closed or
deleted outright — and its commits stay exactly where the author left them.
Every column in the dashboard reads from prog, which stops mentioning that
branch the moment its task moves on, so the commits go quiet rather than
missing, which is worse. The worst case is the quietest: a task back in the
queue with seven commits behind it looks like ordinary unstarted work, and the
author eventually sent to it resumes the work rather than reading it.

Foreman therefore asks git directly for its own branches the checkout has not
taken, and sets aside every task that still reaches an agent on its own. A task
in the queue with commits behind it is not abandoned — it is next in line, and
the queue already works oldest first; its row says `resume` so you can see the
branch is there. The same goes for a claim and for anything in `reviewing`.

What is left has fallen out of every mechanism foreman has: a task marked done
whose branch never landed, one canceled with commits still on it, one deleted
outright. Foreman works that list off itself, one per tick, oldest first, with
no keypress — but only the **done** ones. Those say somebody meant to keep the
work, so unmerged commits mean a landing that stopped part way, which is
foreman's own doing to correct. A cancellation is a decision a person made, and
an automatic review would spend a rung relitigating it; a deleted task has no id
to dispatch against. Both are shown under **Attention**, and `s` submits one by
hand.

A reviewer then reads the diff and either approves it, landing it through the
same gate as anything else, or returns it with findings. Nobody can judge
abandoned commits from the outside, and that judgement is what a review is.

A branch whose task was deleted outright is listed and left alone. Workspaces,
prompts and merges are all addressed by task id, so there is nothing left to
dispatch against — that one is yours to recover by hand.

## When a worker vanishes

herdr reports an empty workspace the same way whether the agent exited cleanly
or you closed the pane to take over yourself. It cannot tell those apart, so
foreman does not guess. The task stays claimed and the dashboard asks you:
retry, hand it back to the queue, or take it over.

A workspace whose task is neither claimed nor under review is residue — a
dispatch that failed after opening it — and the dashboard offers `c` to close
it. The task itself is left alone: a done or canceled task must not be
reopened, and a queued one is dispatched again into a fresh workspace.

A task whose dispatch fails twice with the same error stops being offered and
appears under **Attention** as a dispatch failure, with the error on the row.
The failure is a fact about the world — the worktree or workspace that refused
it is still there next tick — so waiting changes nothing. Clear the cause and
press `r` to retry; the log records the failure once with a count rather than a
line every poll.

Absence is an unknown, not evidence of failure. Escalation needs real evidence.

## Review

An author commits to its branch and runs `prog review`, which hands the task to
the review queue.

Only tasks foreman authored are reviewed. `reviewing` is a status anything can
set, and a task put there by a person or an earlier orchestrator has no branch
behind it — no diff to read, and nothing to merge. Foreman labels each task
`by-<kind>` when an agent actually starts, and that label is what marks the task
as its own.

The branch must also hold a commit. An agent can run `prog review` having
written nothing, and the label alone would send a second agent to read an empty
diff. Foreman asks git for the branches carrying commits the checkout does not
have, and a handoff missing from that list goes straight back to the queue with
a log line saying so. Nothing committed is unfinished work, whatever the status
says.

One empty branch is worth a reviewer: the one whose author found that the trunk
already does what the task asks. A backlog outlives the code it describes, and
an author sent to an entry like that has nothing it can honestly write —
committing anything invents work, and stopping reads as a crash, which costs a
rung and buys the same discovery again at a dearer model. So it records the
finding as a `satisfied` label and hands off. That is a claim, not a verdict:
the reviewer confirms it against the trunk part by part, and only its `approved`
closes the task — with nothing merged and nothing verified, because there is
nothing to merge. A claim the reviewer cannot confirm is returned like any other
work.

When a reviewer starts, foreman also writes `review-by-<kind>`. Status
`reviewing` alone cannot say whether the author just handed off or a reviewer is
already running; the label makes that role survive restarts and vanished panes.
The matching agent pane is labelled `foreman-<role>`, so old settled output
cannot mask the current role's state.

The world records that a reviewer was dispatched, not whether it is still alive.
A task that is open in the queue with a `review-by-*` label and no live reviewer
behind it has a stale label, and only you can say so: the dashboard's `u` clears
it — the same `prog unlabel` foreman runs when a review ends.

A reviewer arrives with no sunk cost in the implementation, which is the point.
It may fix trivia in place; anything substantive goes back to the queue with the
findings logged, and the branch stays put so the next agent continues from it.
On approval the reviewer adds the durable `approved` verdict. Foreman then checks
the shared checkout again, proves the merge, applies it, and marks the task done.
A dirty checkout leaves the approval waiting for a later tick; a conflicting
merge is returned to the queue. The reviewer needs neither merge nor completion
rights.

Proving happens somewhere disposable: a scratch checkout of the project under
`$XDG_STATE_HOME/foreman/verify/`, reset to your current tip. The merge is made
there and the project's `verify` command runs there, so no test suite ever runs
in a directory you are working in, and nothing has to be undone in yours when
one fails. What then lands in your checkout is that same commit — git
fast-forwards onto it, jj moves the bookmark to it — so you get the exact tree
that was verified, and only if your tip has not moved meanwhile.

A branch that turns a green project red never lands, and the task goes back to
the queue carrying the failure output — the next author's whole job is that
output. `verify` runs a second time on the pre-merge tree to establish that,
and only after a failure, since that is the only time the question is live. A
project that was already red still takes the merge, because one broken test
would otherwise hold every task in the fleet. Name the command per project:

```jsonc
"projects": ["fibrae", { "name": "foreman", "verify": "bun test" }]
```

Who reviews whom is derived, not configured: the reviewer is the rung above the
one that wrote the code. Cheap work gets expensive eyes; the top rung reviews
itself, which still helps — fresh eyes on the same model read the diff as a
stranger would. Every branch is reviewed: no priority and no label routes work
around the reviewer, because a task's own estimate of how small it is arrives
before anybody has read the diff.

A re-dispatch replaces the `by-` label rather than adding to it: the question the
reviewer asks is who wrote the code on this branch now, not who has ever touched
the task.

## The ladder

Every model foreman may use is one ordered list, cheapest first. Order is the
rating — there are no price or power numbers to drift out of step with the list,
and no map from author to reviewer, because both "who reads this" and "who tries
next" fall out of the order.

```jsonc
"ladder": [
  { "name": "deepseek", "harness": "opencode", "model": "opencode/deepseek-v4-pro" },
  { "name": "sonnet",   "harness": "opencode", "model": "opencode/claude-sonnet-5" },
  { "name": "claude",   "harness": "claude" },
]
```

`harness` is a herdr agent kind — the program that runs. `model` is handed to it
as `--model`, which is the flag both opencode and claude take; herdr forwards
everything after `--` to the agent's own command line. A bare string is a rung
that is only a harness, running whatever that program defaults to. Two rungs may
share a harness and differ only in model, which is the point: without the model,
every rung would be the same rung.

`provider` is optional and names the account a rung spends. It is read off the
model's `<provider>/` prefix wherever there is one, so most ladders never state
it; the claude harness always spends the claude.ai account, and any other rung
that is only a harness has to be told, or foreman cannot tell whether that
rung has any allowance left before it dispatches. `foreman quota` reports what
each account has left and which rungs are stopped, and a rung whose account is
spent is passed over — the task waits in the queue at the same rung rather than
climbing, because an empty allowance says nothing about the work or the model.

A task starts at the bottom. It climbs one rung — never a jump — on real evidence
that the rung it is on failed it: a reviewer sent the work back, the branch would
not land, or the rung has been spent by `attemptsPerRung` attempts that ended
without finishing. An agent that merely stopped unfinished has said nothing about
its model — a crash, a timeout and a usage wall all end the same way — so the
task stays on the rung and is tried again. Foreman writes the new rung as a
`rung-<name>` label, and the retry count as an `attempt-<rung>-<n>` label, in the
task store rather than in its own memory, because the evidence that a rung failed
here is exactly what a dispatch days later, after a restart, needs to act on. Set
the label by hand to pin a task to a rung.

The rung is a property of the task, never of which slot happened to be free.

### Intervening in stuck work

`e` opens an intervention menu for the selected task. Continue stops any live
role, preserves its worktree and uncommitted edits, asks which configured rung
should take over, and dispatches it immediately. Diagnose and Review appear only
when a branch or surviving worktree proves there is work to inspect. A committed
branch enters formal review; uncommitted Review and Diagnose run a chosen agent
that may fix trivia and logs findings before Foreman resumes the original rung.

The diagnostic lifecycle is durable. Its `diagnosing-*` task label and labelled
agent pane survive a Foreman restart; no intervention depends on process memory.

### The top of the ladder is you

Above the last configured rung is the operator. You are not an entry in the
array: a rung with no harness and no model is a different kind of thing, and an
explicit entry would invite putting a person in the middle, where every task
below them would stall.

A task reaches you two ways. It climbs off the top, meaning nothing configured
could finish it — a task the best model could not do should stop, not cycle. Or
you pin it there with `prog label <task> rung-human`, which is what work that was
never specified needs: dispatching it once to discover that wastes a run.

It waits under dashboard **Attention**, and foreman notifies you, the same
as for a blocked worker — a task that arrives at you silently waits forever. The
column takes no answer key. That is the design: a key to put the task back would
hand the next agent the same unanswered question. Write the decision into the
task with `prog append`, then `prog unlabel <task> rung-human`, in that order.
The next author reads the answer in the description.

The one exception is `x`, which lowers the task one rung — including down from
`rung-human` to the strongest model. A rung is only ever as good as the evidence
that wrote it, and a bug or a killed run can write one that was never earned, so
the operator correcting the climb is the same sort of correction `prog unlabel`
used to be. `x` writes exactly the `rung-*` label foreman would have written.

A rung label naming a model the config no longer has is yours too. The claim
"this task needs at least this much" cannot be read once the model is gone, and
guessing would silently downgrade work that had already earned better.

## The queue

One global `prog ready`, restricted to the allowlisted projects after prog has
applied dependency gates. Tasks are highest priority first, with ties broken by
rotating between projects — otherwise one project holding a hundred priority-1
tasks would own the entire fleet until it ran dry.

Two things bend that order. Waiting earns a task a bounded amount of urgency, so
low-priority work is not starved forever but cannot displace new urgent work
either. And anything labelled `bug` enters holding more credit than waiting can
ever earn, so defects lead their priority band on arrival: a backlog filed
almost entirely at one priority otherwise sorts by age alone, which dispatches
defects in the order they were discovered, behind whatever feature batch was
entered first.

## Pinning

Press `alt-p` on a queue, working or review row to pin its task. Pinned work
leads the queue: the fleet takes it before anything the score would otherwise
have chosen, and reviews of pinned tasks are dispatched first too.

Pin an epic and you pin every ready task under it, however deep, so two pinned
epics are one larger set. That is the way to drive an epic to completion without
narrowing the config to its project.

Nothing is reserved and nothing is serialized. Every free slot fills from the
head of the queue, so several pinned tasks run at once when they can — which
ones can is what the plan already says, since `prog ready` only offers unblocked
work. Order inside the pinned half is the ordinary score; unpinned work keeps
running behind it, and when nothing pinned is ready the queue is simply the
ordinary queue.

The pin is a label in prog, so it survives closing the dashboard. Whole-project
emphasis is still the allowlist: run foreman with one project in the config.

## Configuration

`~/.config/foreman/config.jsonc`, or `$FOREMAN_CONFIG`. Comments and trailing
commas are allowed — Bun's loader parses `.jsonc`, so the config can explain
itself. The extension is what enables that; a file named `.json` is parsed
strictly.

```jsonc
{
  // A name is both the prog project and its directory under ~/build.
  "projects": ["fibrae", "pg-sourcerer", "tsdoctor"],
  "slots": 3,
  // Cheapest first. Order is the rating; the reviewer is the rung above.
  "ladder": [
    { "name": "deepseek", "harness": "opencode", "model": "opencode/deepseek-v4-pro" },
    { "name": "sonnet", "harness": "opencode", "model": "opencode/claude-sonnet-5" },
    "claude",
  ],
  // How many attempts one rung gets before an unfinished task climbs to the
  // next. A crash, a timeout or a usage wall says nothing about the model, so
  // the first attemptsPerRung - 1 retry in place; a reviewer rejection or a
  // branch that will not land climbs at once and spends none of it.
  "attemptsPerRung": 2,
  "pollSeconds": 20,
  "staleAfterHours": 24,
  "landedWindowDays": 7,
}
```

There is no path override: a name that does not match its directory is a naming
mistake, and `prog projects rename` is the fix. Startup fails loudly on a project
that does not resolve, because a queue that silently drops half its work looks
exactly like a queue that is empty.

## The log

Every dispatch, reclaim, return and climb is appended as one JSON object per
line to `$XDG_STATE_HOME/foreman/foreman.jsonl`, or `$FOREMAN_LOG`. The pane
scrolls and dies with the session; the questions worth asking about an unattended
fleet — why this task went to that model, why a claim was released, what happened
at 3am — are all asked long afterwards.

```bash
jq -r 'select(.level == "WARN")' ~/.local/state/foreman/foreman.jsonl
```

The jsonl log outlives the session but not the task. So each assignment is also
appended to the task's own prog history with its role and agent kind, and with
the model when the agent integration reports one — the record travels with the
task, which is what makes attempts comparable once it lands.

Worktrees live under `$XDG_STATE_HOME/foreman/worktrees/<project>/<task>`, out of
the repository — an in-tree worktree would mean editing `.gitignore` in every
project foreman touches.

## Running it

```bash
bun src/main.ts               # from a pane inside the multiplexer
bun src/main.ts --slots 1     # one at a time, to watch a change land
```

It comes up paused: it observes and reports, and waits for `p` before it changes
anything.

`--slots` (`-n`) is the one setting available on the command line, because it is
the one an operator changes per run. Everything else describes the fleet and
lives in the config file.

foreman opens workspaces in the session it is running in, so it must run inside
that session.

## Ports

`Fleet` (`src/fleet.ts`) is the whole multiplexer surface: open a task's
workspace, spawn an agent in it, read the roster, focus, close, notify.
`HerdrFleet` implements it over the herdr CLI. An amux plugin is a second
implementation, not a rewrite.

`Prog` (`src/prog.ts`) is the whole task-store surface. Replacing prog with an
in-house store means writing another implementation of those methods.
