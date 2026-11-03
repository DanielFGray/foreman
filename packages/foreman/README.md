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
and `tasks list` together tell you everything foreman knows.

## What one tick does

1. **Settle.** Every worker that stopped gets resolved by re-reading its task,
   never by interpreting the agent's output. Landed means notify and close the
   workspace. Unfinished means log why, return the task to the queue with the
   agent's own notes attached, and free the slot. Blocked means notify you and
   change nothing — approvals stay human.
2. **Tidy.** Foreman's merged branches are deleted from every project. `-d`
   refuses anything the checkout does not already have, so only redundant refs
   go.
3. **Reclaim.** A claim with no live worker and no activity for a day goes back
   to the queue. Ownership decides this, not age: a task with a live workspace
   is never touched.
4. **Fill.** Reviews first, then new work. A task awaiting review is nearly
   finished and is blocking whatever depends on it; an unclaimed task has not
   started costing anything yet.

## What the fleet may do by itself

Four steps spend tokens or write to your checkout, and each runs only where
the policy in `~/.config/foreman/policy.json` (or `$FOREMAN_POLICY`) allows
it:

- **author** starts a task no attempt has touched.
- **climb** starts a task again after an attempt that did not finish it. The
  failure is recorded either way; this decides only whether the retry waits
  for you.
- **review** sends a reviewer to a finished branch.
- **land** proves the merge in the proving ground and applies it.

```json
{
  "paused": false,
  "default": { "author": "off", "climb": "off", "review": "on", "land": "off" },
  "grants": [{ "scope": "ep-1234", "steps": ["author", "review"], "remaining": 3, "admitted": [] }]
}
```

`default` holds for every task, and each step is one of three modes: `on` runs
it, `ask` makes the dispatcher report the task and wait for one approval, and
`off` does nothing. `foreman approve <id>` gives one approval: it writes a grant
for that task and that step, once. `foreman wait --asks` returns when a new ask
appears. A grant widens `default` for one task, or for an epic
and every task under it. `remaining` counts tasks: the grant takes on at most
that many, and keeps covering each one until it is finished, so a task it
authored still gets its review and landing. The dispatcher records those
tasks in `admitted` and removes a grant that has nothing left to do. `slots`
is how many agents may work at once.

The policy also says whether a tick acts at all. The dispatcher is in one of
three states:

- **running**: a step is `on` or `ask`, or a grant exists. Each tick settles, tidies, reclaims,
  recovers and fills.
- **paused**: `paused` is set. Grants are kept for later.
- **idle**: every step is `off` and no grant exists.

A paused or idle tick reads the world and publishes the reading, and writes
nothing: no prog change, no git change, no workspace opened, stopped or
closed, no policy change. Settle, tidy, reclaim and recover wait too, so a
workspace whose agent stopped stays open until the fleet runs again.

Change it with `foreman policy` (`pause`, `resume`, `set <step> on|ask|off`,
`slots <n>`, `grant <id> <steps...> [--count n]`, `revoke <id>`) or from the
Foreman pane. Both write the file the same way, and the dispatcher reads it on every
tick. With no file the fleet takes no step. A file that does not decode pauses
the fleet, and the Foreman pane shows why.

`foreman dispatch` is not gated: it starts the author you asked for.

The poll interval is how long foreman waits to notice something nobody told it
about.

A fresh agent per attempt and review, rather than long-lived workers fed task
after task: no context bleeds between stages or unrelated projects. The author
runs in the task workspace's own pane; only a reviewer splits a second pane
beside it.

## Driving it by hand

Every dashboard key is also a subcommand, and so are the steps an agent
coordinator needs: `foreman status`, `foreman dispatch <id>`, `foreman wait
<id>`, `foreman prompt author|review <id>`. Each one reads the world once,
does one thing and exits, so it works with or without the dispatcher running.
`foreman --skill` prints how to use them.

## Projects you are working in

You share each project's checkout with the fleet: every task ends by landing
into it. Your uncommitted edits hold only the landings that would write the
same files. Such a landing waits, named in the dashboard, until you commit or
stash those files. Work elsewhere in the checkout lands around you, and your
edits stay as they were.

A checkout with no branch is held, because a landing has nothing to move: that
is a detached `HEAD`.

The held row says which cause it is. An uncommitted change clears itself; a
missing landing target never does, and needs a hand-run command instead.

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
the queue already works oldest first. The same goes for a claim at any step
of its pipeline. A queue row does not show the branch, because
`foreman queue` reads the task store only; a parked row under Needs you shows
it as `resume`.

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

An author commits to its branch and names an exit (`foreman exit <task> done`),
which places the task at the next block the drawing wires that exit to — review,
in the standard pipeline. The task stays `in_progress`; its step is the block's
name, not a status.

Only tasks foreman authored are reviewed. A task with no author run has no
branch behind it — no diff to read, and nothing to merge. Foreman opens an
author run when an agent actually starts, and that run is what marks the task
as its own.

The branch must also hold a commit. An agent can name `done` having written
nothing, and the run alone would send a second agent to read an empty diff.
Foreman asks git for the branches carrying commits the checkout does not have,
and a handoff missing from that list goes straight back to the queue with a log
line saying so. Nothing committed is unfinished work, whatever the status says.

Two empty branches are worth a reviewer. The first is the author that found the
trunk already does what the task asks. A backlog outlives the code it describes,
and an author sent to an entry like that has nothing it can honestly write —
committing anything invents work, and stopping reads as a crash, which costs a
rung and buys the same discovery again at a dearer model. So it records the
finding by naming the exit `already-done`. The second is a task labelled
`research`, whose deliverable is a report in its own log — a measurement or an
investigation — and never a diff. Neither is an approval: the reviewer confirms an
`already-done` claim against the trunk and a `research` report against its cited
evidence, part by part, and only its `approved` closes the task — with nothing
merged and nothing verified, because there is nothing to merge. A claim the
reviewer cannot confirm is returned like any other work.

When a reviewer starts, foreman opens a review run. Placement at the review
block covers both the author's completed handoff and the whole review run; an
open review run is what says a reviewer was dispatched, so a vanished worker
behind one is a question for the operator. The matching agent pane is labelled
`foreman-<role>`, so old settled output cannot mask the current role's state.

The world records that a reviewer was dispatched, not whether it is still alive.
A task that is open in the queue with a `review-by:*` label and no live reviewer
behind it has a stale label, and only you can say so: the dashboard's `u` clears
it — the same `tasks unlabel` foreman runs when a review ends.

A reviewer arrives with no sunk cost in the implementation, which is the point.
It may fix trivia in place; anything substantive goes back to the queue with the
findings logged, and the branch stays put so the next agent continues from it.
On approval the reviewer names the exit `approved` on the tip it read. Foreman then checks
the shared checkout again, proves the merge, applies it, and marks the task done.
A dirty checkout leaves the approval waiting for a later tick; a conflicting
merge is returned to the queue. The reviewer needs neither merge nor completion
rights.

Proving happens somewhere disposable: a scratch checkout of the project under
`$XDG_STATE_HOME/foreman/verify/`, reset to your current tip. The merge is made
there and the project's `verify` command runs there, so no test suite ever runs
in a directory you are working in, and nothing has to be undone in yours when
one fails. What then lands in your checkout is that same commit, fast-forwarded
onto, so you get the exact tree that was verified, and only if your tip has not
moved meanwhile.

A branch that turns a green project red never lands, and the task goes back to
the queue carrying the failure output — the next author's whole job is that
output. A failed run is repeated once on the same merged tree first: a pass on
the retry is a flake, not a defect, and the branch lands verified. A failure
that reproduces is the branch's, and `verify` then runs a second time on the
pre-merge tree to establish whether it was red already — only after a confirmed
failure, since that is the only time the question is live. A project that was
already red still takes the merge, because one broken test would otherwise hold
every task in the fleet. A project names the command by keeping an executable
`scripts/verify.sh`; without one, a landing rests on the merge alone.

Who reviews whom is derived, not configured: the reviewer is the rung above the
one that wrote the code. Cheap work gets expensive eyes; the top rung reviews
itself, which still helps — fresh eyes on the same model read the diff as a
stranger would. Every branch is reviewed: no priority and no label routes work
around the reviewer, because a task's own estimate of how small it is arrives
before anybody has read the diff.

A re-dispatch replaces the `by:` label rather than adding to it: the question the
reviewer asks is who wrote the code on this branch now, not who has ever touched
the task.

## The ladder

Every model foreman may use is one ordered list, cheapest first. Order is the
rating — there are no price or power numbers to drift out of step with the list,
and no map from author to reviewer, because both "who reads this" and "who tries
next" fall out of the order.

The ladder is the `ladder` table of the model registry, which lives in the task
store (`~/.prog/prog.db`; `$PROG_DB` points elsewhere). Foreman reads it at start and refuses to run without it: a second
copy of the order in a config file would be a copy that can disagree. Each rung
is a name, a model, and flags; the model's row in the `models` table says which
harness runs it and at what thinking level, and foreman passes that level at
launch (`--effort` for claude, `-c model_reasoning_effort=` for codex,
`--thinking` for pi; opencode and cursor choose their own).

```
foreman ladder                 # print the ladder: state, trial record, launch arguments
foreman ladder size            # landed slices and cost per success, by model and size
foreman ladder drift           # rungs opencode no longer lists; free models no rung names
foreman ladder suggest [--json] [--catalog PATH] [--after RUNG] [--size N]
                               # [--context-tokens N] [--input-tokens N]
                               # [--cache-read-tokens N] [--cache-write-tokens N]
                               # [--output-tokens N]
                               # advise an economical enabled rung from models.dev
                               # list prices and current subscription quotas (no dispatch)
foreman ladder edit            # edit it in $EDITOR
foreman ladder disable <rung>  # stop dispatching a rung, keeping its rank
foreman ladder enable <rung>
```

`suggest` is advisory only. It does not change rung order or dispatch anyone:
`authorFor` and failure evidence stay authoritative. It prices a four-part token
budget (uncached input, cache read, cache write, output) from the median of
recorded trials (optionally filtered with `--size`), or from the token flags when
you pass them, against exact `models.models_dev` identities in the models.dev
catalog (`--catalog` for a local `api.json`). Subscription remaining percentages
and reset times are shown as observed facts, never as dollars or predicted runs.
Unknown price, quota or billing stays visibly unknown. An `unmetered` rung is not
walled by a spent account allowance.

`edit` opens one JSON object per rung, cheapest first. Reordering is moving a
block; the result is validated (known models, unique names, at least one rung on)
and written in one transaction, so a typo changes nothing. A rung may carry
`provider`, `unmetered` and `note`.

A rung's `model` must already have a row in `models`; add that row with the herd
skill's `schema-registry.sql`.

`provider` names the account a rung spends. It is read off the model's
`<provider>/` prefix wherever there is one, so most rungs never state it; the
claude harness always spends the claude.ai account, and any other rung that is
only a harness has to be told, or foreman cannot tell whether that rung has any
allowance left before it dispatches. `foreman quota` reports what each account has
left and which rungs are stopped, and a rung whose account is spent is stepped
over — the next rung that can pay takes the work, and if none can the task waits
in the queue with nothing recorded against it, because an empty allowance says
nothing about the work or the model.

`enabled` defaults to true. Disabling a rung retires it without deleting it,
which keeps its rank: the failures already recorded against it still position
every task that earned its way past it.

A task names no rung. What foreman records is evidence: a charge for each rung
that was tried and was not enough, and the runs that ended without an exit,
which count the retries. Foreman picks the author at dispatch — the cheapest
rung that is in the ladder, enabled, funded, and above every rung recorded as having
failed this task. So a rung disabled in the registry, or an account with
nothing left, moves work along instead of stranding it.

A failure is written on real evidence only: a reviewer sent the work back, the
branch would not land, or the rung has been spent by `attemptsPerRung` attempts
that ended without finishing. An agent that merely stopped unfinished has said
nothing about its model — a crash, a timeout and a usage wall all end the same
way — so nothing is recorded and the same rung is tried again. The evidence lives
in foreman's database rather than in its memory, because a dispatch days later,
after a restart, is exactly what reads it. To start a task above a rung you know
is not enough, launch it on the rung you want, or intervene and continue on it:
either charges every rung below.

Which rung runs is derived at dispatch, never inherited from which slot happened
to be free.

### Intervening in stuck work

`e` opens an intervention menu for the selected task. Continue stops any live
role, preserves its worktree and uncommitted edits, asks which configured rung
should take over, and dispatches it immediately. Diagnose and Review appear only
when a branch or surviving worktree proves there is work to inspect. A committed
branch enters formal review; uncommitted Review and Diagnose run a chosen agent
that may fix trivia and logs findings before Foreman resumes the original rung.

The diagnostic lifecycle is durable. Its `diagnosing:*` task label and labelled
agent pane survive a Foreman restart; no intervention depends on process memory.

### The top of the ladder is you

Above the last configured rung is the operator. You are not an entry in the
array: a rung with no harness and no model is a different kind of thing, and an
explicit entry would invite putting a person in the middle, where every task
below them would stall.

A task reaches you two ways. Its recorded failures leave no rung above them,
meaning nothing configured could finish it — a task the best model could not do
should stop, not cycle. Or a block parks it: the drawing routes it to a park,
an agent stopped at a block drawn `stopped: park`, or no reviewer is left. Work
that was never specified is a `draft` (`tasks draft <task>`), which keeps it out
of the queue: dispatching it once to discover that wastes a run.

It waits under dashboard **Attention**, and foreman notifies you, the same
as for a blocked worker — a task that arrives at you silently waits forever. The
column takes no answer key. That is the design: a key to put the task back would
hand the next agent the same unanswered question. Write the decision into the
task with `tasks append`, then press `x` (`foreman descend <task>`), in that
order. The next author reads the answer in the description.

`x` takes back one thing that put the task here: its park, otherwise the
highest charged rung. Evidence is only ever as good as the run that wrote it,
and a bug or a killed run can charge a rung that never earned it, so the
operator takes it back. The charge stays in foreman's database, marked
forgiven.

## The queue

One global `prog ready`, restricted to the open spaces' projects after prog has
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

Some ready tasks never enter the queue. One that is parked, or one every rung
has failed, waits under Needs you; one labelled `onboard` is held for the
project's onboarding. A task whose dispatch failed twice in a row is held out
by the dispatcher for as long as it runs; that count lives in its memory only.
One function, `queueFrom` in `src/queue.ts`, makes this split for both the
dispatcher and `foreman queue`.

The queue is not in `state.json`. The Foreman pane runs
`foreman queue --project <name> --json`, and herdr-web makes the same read in
its own process (`queueOf` in `src/host.ts`). It reads only the task store and
the open spaces, with no agent roster and no branch checks, so it answers in
under a second.


## Configuration

`~/.config/foreman/config.jsonc`, or `$FOREMAN_CONFIG`. Comments and trailing
commas are allowed — Bun's loader parses `.jsonc`, so the config can explain
itself. The extension is what enables that; a file named `.json` is parsed
strictly.

```jsonc
{
  "slots": 3,
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

The projects are not configured. Foreman works in every herdr-app space you
have open: each space's folder resolves to the git checkout it sits in, and the
checkout's folder name is the prog project. Open a space to enroll a project;
close it and the project takes no new work, while what is already running there
settles and lands. Two checkouts with one folder name are held, named on the
dashboard, until you close one of their spaces.

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

`foreman serve` runs the dispatcher, supervised. A failure is logged, shown in
the Foreman pane and herdr-web as `failed`, and the dispatcher starts again
after a pause that doubles from a second up to a minute. After each reading
serve writes `state.json`. It holds a lock (`serve.lock`, beside `state.json`)
for its life, so a second serve refuses to start. When foreman's own checkout
gets a new commit, serve exits, and its service starts it on the new code.

A systemd user unit runs serve at login and starts it again when it stops. It
runs from `~/build/foreman` through a login shell, so its PATH is the one your
shell has, which must hold every program the dispatcher runs: `prog`, `hc`,
`git`, `gh` and each rung's harness. To install it:

```bash
systemctl --user link ~/build/foreman/packages/foreman/systemd/foreman.service
systemctl --user enable --now foreman.service
journalctl --user -u foreman -f   # its log
```

A command you run in another process does not wake serve: serve reads its
change on the next poll. The rest of the command line is one-shot commands:

```bash
bun src/main.ts policy slots 1  # one agent at a time, to watch a change land
bun src/main.ts status          # one reading, printed
```

What it starts by itself is the policy's to say; see above.

foreman opens workspaces in the session it is running in, so serve must
reach that hc server.

## Ports

`Fleet` (`src/fleet.ts`) is the whole multiplexer surface: open a task's
workspace, spawn an agent in it, read the roster, focus, close, notify.
`HerdrFleet` implements it over the herdr CLI. An amux plugin is a second
implementation, not a rewrite.

`Tracker` (`src/tracker.ts`) is the whole task-tracker surface. Another tracker
is another implementation of it; foreman's own records (`src/records.ts`) stay
in foreman's store. "Forking for your own workflow" in AGENTS.md lists
what to edit for another workflow.
