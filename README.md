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

> **Status:** compiles and has focused unit tests. The first live author → review
> → merge proof is still pending; see `AGENTS.md` before running it unattended.

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
2. **Reclaim.** A claim with no live worker and no activity for a day goes back
   to the queue. Ownership decides this, not age: a task with a live workspace
   is never touched.
3. **Fill.** Reviews first, then new work. A task awaiting review is nearly
   finished and is blocking whatever depends on it; an unclaimed task has not
   started costing anything yet.

A fresh agent pane per attempt and review, rather than long-lived workers fed
task after task: no context bleeds between stages or unrelated projects.

## Projects you are working in

A project whose checkout has uncommitted changes to tracked files is **held**:
foreman passes over its tasks and names it in the dashboard, then picks it up
again on the tick after you commit or stash. You share that checkout with the
fleet — every task ends by merging into it — so a dispatch there would move your
branch under you while you edit.

Untracked files do not hold a project. Scratch notes and build output sit in a
repository for months; counting them would hold it forever.

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

Onboarding runs when you ask, for any held project — foreman cannot tell a
checkout you stepped away from a fortnight ago from one you are typing in this
minute, and you can. The task carries an `onboard` label so the queue never
starts one on its own.

Agents themselves never enter your checkout, with that one exception. Each works in its own worktree
under `$XDG_STATE_HOME/foreman/worktrees/`, on a branch off your current `HEAD`,
and the author prompt forbids touching the main checkout or switching branches.
The one time an agent writes there is the merge, and it re-runs the same check
first — your tree can go dirty hours after dispatch. If it has, the agent leaves
its branch, says so on the task, and returns the task to the queue.

## One workspace per task

Dispatching a task opens a herdr workspace labelled `foreman/<task-id>`, holding
a git worktree on a branch of the same name. That durable label identifies the
work; ephemeral agents use valid names derived from their pane because herdr
agent names cannot contain `/` and old output panes remain visible.

The workspace outlives the agents inside it. The author finishes and its pane
closes; the reviewer opens a fresh pane in the same workspace, against the same
worktree, beside the author's output. The workspace closes when the task leaves
the fleet. The branch is kept either way: if the work merged the branch is
harmless, and if it was rejected the branch is the only copy of what happened.

## When a worker vanishes

herdr reports an empty workspace the same way whether the agent exited cleanly
or you closed the pane to take over yourself. It cannot tell those apart, so
foreman does not guess. The task stays claimed and the dashboard asks you:
retry, hand it back to the queue, or take it over.

Absence is an unknown, not evidence of failure. Escalation needs real evidence.

## Review

An author commits to its branch and runs `prog review`, which hands the task to
the review queue.

Only tasks foreman authored are reviewed. `reviewing` is a status anything can
set, and a task put there by a person or an earlier orchestrator has no branch
behind it — no diff to read, and nothing to merge. Foreman labels each task
`by-<kind>` when an agent actually starts, and that label is what marks the task
as its own.

When a reviewer starts, foreman also writes `review-by-<kind>`. Status
`reviewing` alone cannot say whether the author just handed off or a reviewer is
already running; the label makes that role survive restarts and vanished panes.
The matching agent pane is labelled `foreman-author` or `foreman-review`, so old
settled output cannot mask the current role's state.

A reviewer arrives with no sunk cost in the implementation, which is the point.
It may fix trivia in place; anything substantive goes back to the queue with the
findings logged, and the branch stays put so the next agent continues from it.
On approval the reviewer merges and marks the task done.

Who reviews whom is `reviewers` in the config, author to reviewer. Cheap work
escalates to an expensive model; a uniform fleet reviews itself, which still
helps — fresh eyes on the same model read the diff as a stranger would. Priority
3 and anything labelled `trivial` skips review entirely.

A re-dispatch replaces the `by-` label rather than adding to it: the question the
reviewer asks is who wrote the code on this branch now, not who has ever touched
the task.

## Escalation

The default author is the cheap kind. Most tasks are ordinary, and paying
frontier prices for all of them to catch the few that are hard is the expensive
way round.

A task escalates when cheap has demonstrably failed on it — the agent settled
without finishing, or a reviewer sent the work back. Foreman then labels the task
`escalated`, and the next dispatch sends it to `escalateTo`. The label lives in
the task store rather than in foreman's memory, because the evidence that cheap
failed here is exactly what a dispatch days later, after a restart, needs to act
on. Set it by hand to send a task straight to frontier.

Escalation is a property of the task, never of which slot happened to be free.

## The queue

The union of `prog ready` across the allowlisted projects, highest priority
first, ties broken by rotating between projects — otherwise one project holding
a hundred priority-1 tasks would own the entire fleet until it ran dry.

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
  "author": "opencode",     // writes the code by default; keep it cheap
  "escalateTo": "claude",   // where a task goes once cheap has failed on it
  "reviewers": { "opencode": "claude" },
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

Every dispatch, reclaim, return and escalation is appended as one JSON object per
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
