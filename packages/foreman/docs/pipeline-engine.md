# Pipelines: foreman runs a wired graph of blocks

Status: built, and live in `develop` since 2026-11-02. Prototype: branch
`prototype/pipeline-editor`.

## What changes

Today the dispatcher runs one flow, written into `settle`, `fill` and `land`:
queue → author → review → land. A **pipeline** makes that flow data. Each
project has one: a graph of **blocks** (nodes) joined by **wires**. The
dispatcher places each task in the graph and runs the block it stands at. With
no pipeline set, a project runs the **default pipeline**: the standard pipeline
in the operator's checkout, on the task's branch. `foreman pipeline use
<checkout|worktree|direct> --project <name>` draws one of the three standard
workspace choices (`docs/workspace-blocks.md`).

The executors stay: dispatching an agent into the task's worktree, reading how
its run ended, landing, usage walls, trials, teardown. What the pipeline
replaces is the fixed answer to "which step does this task take next".

## Where things live

| Question | Answered by |
| --- | --- |
| What does this project's flow look like? | its entry in `pipelines.json` beside the policy file, else the default pipeline (the standard checkout choice) |
| Where is this task in it? | derived every tick by `place` from the task's facts |
| Which block did it last leave? | a fact: the exit its last named run named, and the commit it was named on |
| May this step run for this task? | the policy: the gate's step, its mode, grants (unchanged) |

The pipeline is operator intention. It lives in its own file, `pipelines.json`
(`$FOREMAN_PIPELINES` overrides), in the policy file's directory: the
dispatcher already watches that directory, because writes replace a file by
rename, so one watch sees a change to either file. Both files are written
through `rewrite` in `src/shared-file.ts`.

A task's position is not stored. `place` replays the graph from the source with
the task's **facts** each tick (status, priority, epic, size, the rungs that
failed it, its attempts, the exits it named), the same way the ladder reads `failed-by` labels
instead of storing the next rung. A run's `node` and its exit record a fact (the
agent at that block named that exit), so they do not rot: if the operator
deletes the block or the exit, the run places nothing and the task starts at
its source again.

## Exits

An agent or a check ends its run by naming an **exit**. Each exit is a wire to
the block that comes next, or to `queue`. An agent names its exit with
`foreman exit <task> <name>`; foreman names a check's `passed` or `failed`. A
run that stops with no exit has a **process ending**: `stopped`, `vanished`,
`walled`, `released` or `canceled`.

An exit to `queue` is a **return**. It releases the task to the queue, which
keeps the evidence it earned (`failed-by`, `attempt`). The task then re-enters
at a source, and routers send it on by that evidence.

This is the doctrine "a task records what failed it, never what runs next",
applied to the graph. The exit is evidence of what the agent said; its wire is
read from the drawing as it is now, so an edit to the wire moves the task.

An exit may wire back to an earlier block, so the graph may hold a cycle.
Validation refuses a cycle that cannot end. In the standard pipeline, a returned
review follows a cycle through the `climb` gate to the next author, keeping the
claim and workspace. See "The standard pipeline, drawn with exits" in
`agent-exits.md`. Saved pipelines keep their drawn returns to the queue.

## Blocks

| Kind | Props | Forward | Runs |
| --- | --- | --- | --- |
| source | `filter` | `next` | Ready tasks in queue order that match the filter. A task enters the first source that matches. |
| router | `routes: [{when, to}]`, `else` | per route | Instant. The first route whose filter matches. |
| gate | `step` | `next` | Holds the task before the next work block until the policy permits `step` for it. `ask` lists it for approval. |
| branch | — | `next` | Instant. Makes `foreman/<id>` from the trunk tip when the first agent is dispatched. git records it as passed. |
| worktree | — | `next` | Instant. Puts the task's branch in a directory of its own. Without one, agents work in the operator's checkout. See `docs/workspace-blocks.md`. |
| agent | `role`, `model`, `slots?`, `stopped?` | `exits` | A work block. Dispatches an agent and waits for it to name an exit or stop. |
| land | `how?`: `merge` (default) or `fast-forward` | (ends) | A work block. Lands the approved commit, which completes the task. |
| done | — | (ends) | A work block. Completes a task that has no branch: its commits are already on the operator's branch. |
| park | — | (ends) | Parks the task for the operator (a row in `parks`). |
| check | `command` | `exits`: `passed`, `failed` | A work block. Runs `command` on the task's branch tip, in the project's proving ground. Takes no slot. |

A **work block** is one that runs something and takes time: agent, check, land,
done. Sources, routers, gates, branches and worktrees decide at once.

### How each work block ends a run

| Block | Advances when | Returns when |
| --- | --- | --- |
| author agent | the author names `done` or `already-done` (stays `in_progress`; placement follows the exit) | it stops with no exit or hands back an empty branch (`stopped: retry`: an attempt, and `failed-by` once the rung is spent) |
| review agent | the reviewer names `approved` and the branch tip is still the commit it named it on | the reviewer names `returned` (`fails: author`: `failed-by` the author's rung) |
| land | the merge lands (the task is done) | a conflict (no evidence) or broken verification (`climb`) |
| done | the approval holds for the checkout's HEAD (the task is done) | — |
| check | `passed`: `command` exits 0 on the branch tip, or fails at the commit the branch was cut from as well | `failed`: `command` fails twice on the tip and passes where the branch was cut (`fails: author`, with the output in the task's log) |

This table is the standard wiring. An operator may wire any exit to any block
or to `queue`. An exit with `fails: author` charges the rung of the task's last
author run, and `fails: self` charges the author block's own rung.

A stop with no exit follows the agent block's `stopped`: `retry` (the default)
keeps the task at the block, so a reviewer that stops while another reviewer
is left tries again on that one; `park` parks the task. A usage wall, a blocked
agent and a dirty checkout are not endings: the task stays at the block. Every
rung failed, or no reviewer left, parks the task.

The run that named the exit is the record: its `node`, its exit and the commit
it was named on. No label carries a signal and nothing clears one.

### A review passes one commit

`foreman exit` records the commit the exit was named on: the task's tip by its
route (the branch tip, or the checkout's HEAD on a direct route). The exit
holds only while the tip is still that commit, so a correction round needs no
special case: the reviewer names its exit after the round, on the new tip. A commit after the review opened (the author's, a repair's, or the
operator's by hand) places the task at the review block again, and no code
clears anything to make that happen. Land checks the tip once more, then merges
the recorded commit by its id, never the branch name, so what lands is exactly
what the reviewer read. A tip that moved in between sends the task back to the
review block; landing the older commit would close the task and strand the
newer one.

This replaces today's rule that every transition which hands a task back must
clear `approved` (`Prog.release`, `review`, `submit`, `clearReview`). That rule
holds only while every path remembers it; a recorded commit holds by itself.
`Held` still keeps an `approved` exit: the tip has not moved, so it still holds.

### A check passes one commit

A check runs its command where landing runs verify: in the project's proving
ground, checked out at the branch tip, so it judges exactly that commit and
writes to no tree a person or an agent uses. A failure is retried once, as a
flake, and then run where the branch was cut from its trunk: a command red
there too says nothing about the branch, so the check passes with a note in
the task's log. A ground that is not ready, or a tip that moved while the
command ran, records nothing, and a later tick checks again.
The command runs inside the tick, as verify does, so a slow command delays
everything else that tick does, once per commit at each check.

The check records a run with the commit it ran on and the exit `passed` or
`failed`. The run names no model: the views about models leave it out. Like a
review's exit, it holds only while the branch tip is still that commit, so a
later commit places the task at the check again.

The policy has no step of its own for a check, so the gate before a check
names one of the existing steps.

### Models

`model` is, for an author, `ladder` (from the lowest level above every level
with a rung the task failed, the author-on rung that started a run least
recently) or a rung name that may author (pinned); a pinned author block that
has a `failed-by` for its rung has no rung left, so the task parks. For a
reviewer, `model` is `reviewers` (the reviewer whose last review started
longest ago, off a spent account, preferring a model other than the author's)
or one reviewer's name. A reviewer that stopped this lap with no verdict is
passed over, and with none left the task parks. The drawing check refuses a
name that is no reviewer, and `ladder` or `reviewers` on the wrong role. A router in front of it is how a pipeline sends such a
task elsewhere. `slots` caps how many of the block's tasks run at once, inside
the fleet's `slots`.

### Filters

A filter is a list of terms; all must match. A `-` in front negates a term.
Filters read facts, never label strings, so when runs replace labels only
`factsOf` changes.

- `label:<name>`: a person set the label (for example `research`).
- `epic:<id>`: the task's parent epic.
- `failed`: any rung failed it. `failed:<rung>`: that rung did.
- `exit:<name>`: the task's last exit was `<name>`.
- `size`, `priority`, `attempts` or `exits:<name>` compared with `<=`, `>=` or
  `=` to a whole number (`size` is 1 when unset). `exits:<name>` counts the
  times the task named that exit since it last left a source; a return counts
  as leaving.

## Placement

`place(pipeline, task)` is a pure function:

1. Start at the first source whose filter matches the task. No match: the task
   is not in this pipeline.
2. A task with an open agent run is **at** that run's block: `ended` when the
   run named an exit, else `running`. Settle closes an ended run once the
   agent's pane is idle, and the next tick places the task where the exit leads.
3. Otherwise take the task's last named exit, find it on its block in the
   drawing as it is now, and walk from its wire. An open task, a return, a
   missing block or exit, or no exit at all: walk from the source.
4. Walk forward. At a router, follow the first matching route. At a gate,
   remember the gate. Stop at the first work block. The task is **at** that
   block, `waiting`; the remembered gates decide when it may start. The walk
   has a step bound, so a cycle of routers cannot hang it.
5. **An exit holds for the commit it was named on.** When the walk reaches a
   land or a done, or the exit was named at a check, and the tip is not that
   commit, the exit is void: the task is placed by the exit before it, so a
   commit after `approved` places the task at the review again.
   A land or a check is always `waiting`: each runs inside one tick and
   leaves no open run.
6. A park ends the walk with the task parked.

A task with work in flight when pipelines start has runs from step 4, so it is
placed by the same steps. No move-in step is needed.

## The tick

The passes keep their order and their reasons. Only a running fleet acts, and
settle comes before fill.

1. **Read**, unchanged. The pipeline comes with the policy.
2. **Settle.** For each owned task, classify the run's end as today (`phaseOf`,
   the merge result). An advance closes the run. A return does today's
   bookkeeping and releases the task.
   The landings and checks the last plan holds run here, one at a time,
   landings first: they share the project's proving ground.
3. **Plan.** Place every queued and owned task. A task `waiting` at a work block
   is a candidate when every remembered gate permits it. A gate in `ask` mode
   gives an ask. Candidates are taken nearest to the end first (fewest work
   blocks left), then in queue order. This is today's "reviews before new
   work", stated for any graph.
4. **Fill**, **tidy**, **reclaim**, **recover**, unchanged.

## Validation

A pipeline that fails validation is not run. The reading says why, and the
project takes no step. It never falls back to the standard pipeline, because
running a flow the operator did not draw is worse than stopping.

- Block kinds and props as above; pinned rungs are on the ladder.
- At least one source. Every wire and every exit ends at a block or `queue`.
  Every block is reachable from a source, and from every block some route
  reaches a land, a done or a park.
- An agent block declares at least one exit. Exit names are unique on their
  block, match `[a-z-]+`, and are not process endings. A check's exits are
  `passed` and `failed`, and `fails: self` is refused there: a check has no rung.
  A review block refuses `fails: self` too: a reviewer is no rung.
- Every lap of every cycle can end: each lap passes an exit that has `fails`,
  or a router that leaves on a count that grows each lap (`exits:<name>>=N` or
  `attempts>=N`). A smaller loop inside a cycle that passes neither is a
  problem, even when the larger cycle charges. A cycle through no work block is
  a problem.
- A router filter that counts an exit (`exit:<name>` or `exits:<name>>=N`)
  names an exit some block declares, or a process ending. A rename or a removal
  that leaves the filter counting nothing is a problem.
- **Every path to a land or a done passes a review agent after its last
  author.** With the reviewers taken out of the graph, no land or done is
  reachable from a source or an author.
- A path from a branch ends at a land or a park, never a done: work on a
  branch must land. A worktree or a land needs a branch before it on every path,
  and no branch or worktree stands after an agent or a check.
- Every agent has a gate on each path into it, and so does every check and
  every land and done. With the gates taken out, and the walk halted at each work
  block, no work block is reachable from a source or from the work block
  before it. A step that spends without a policy step would be one the
  operator cannot stop.
- Every path to a check passes an author first: a check before any author
  runs on a branch with no work. A check is not a review, so a land after
  a check still needs a review after its last author.
- A check names a command.
- A pull-request land (`how: pull-request`) takes two gates on every path into
  it after the last agent or check: a `publish` gate, which pushes and opens the
  pull request, and a `land` gate, which merges it. Either step can be on while
  the other is off, so one gate cannot stand for both. A `publish` gate from
  which no route reaches a pull-request land is a problem: it would hold a step
  that never comes.

These are reachability checks with `effect/Graph`, which also finds cycles and
draws the pipeline as Mermaid (`foreman pipeline show`).

## The standard pipeline

The standard pipeline has three workspace choices. The blocks between the source
and the router say where the agents work: `branch` (checkout, the default),
`branch → worktree` (worktree), or none (direct). Direct ends at `done` in place
of `land`.

```
source(all) → workspace blocks
  → router: failed      → gate(climb)
            attempts>=1 → gate(climb)
            else           → gate(author)
gate(author), gate(climb) → agent(author, ladder)
  → gate(review) → agent(review, above)
  → gate(land) → land
```

The router is `authorStep` in `src/policy.ts` drawn as a block. A conflict
returns with no evidence, so the router reads the same labels it reads today,
and the policy step that holds the retry is unchanged.

## Rules this changes in AGENTS.md

- "Durable state beyond the policy file is a wall" and "The policy file is the
  one durable thing foreman holds": changed. The operator's intention is in the
  policy, pipelines, drafts and instructions files, all written the same way.
- "Nothing skips review": kept, and enforced by validation.
- "Order inside a tick ... reviews are filled before new work": generalised to
  nearest-to-the-end first. Same order in the standard pipeline.
- "`awaitingLanding` reads that label": becomes "placed at a land block".
  The reviewer's `foreman exit` writes the review run's exit and the commit it
  was named on; the run is the record.
- "Approval is a durable `approved` label … any transition handing the task
  back … must clear it" and "`Prog.release` therefore clears it alongside
  `approved`": replaced at step 4. A review passes the commit it read, and a
  moved tip voids it (see "A review passes one commit"). `review-by:*` and
  `review-failed-by:*` go with the labels; the review run's open and close
  replace them.
- "`satisfied` is cleared wherever `approved` is": replaced. `already-done` is
  an exit of the author block.
- "`Held` … leaves the task in `reviewing` with its `approved` label": the task
  stays `in_progress` at its land step; the tip has not moved, so the review
  still passes.

## Build order

Each stage keeps every existing test green and commits after the gate. The work
is on a feature branch in its own worktree, because the live dispatcher runs
from the main checkout and lands into `develop` there.

1. Done: `src/pipeline.ts`: schema, facts, filters, placement, validation,
   Mermaid, the standard pipeline.
2. Done: `pipelines.json` and `foreman pipeline show|check|set|clear`.
3. Done: herdr-web's Pipeline page: the editor. It draws, checks and saves
   through foreman's commands, and needs nothing from the dispatcher.
4. Done: runs replace labels (tasks step 3b; design in `runs-replace-labels.md`); `factsOf` reads runs and each task's
   branch tip. A review run records the commit it read, and land merges that
   commit by id. Pass criterion: a commit to an approved branch places the task
   at the review block again, with no clearing code on any path; land refuses a
   tip other than the recorded commit; the code that clears `approved` on
   requeue is gone.
5. Done: the dispatcher runs the standard pipeline through `place`. Pass criterion:
   the dispatcher tests pass with no test edited, a table test maps each
   `TaskPhase` and merge verdict to its old and its placed next step, and
   placement of the live tasks matches today's working, review and queue views.
6. Done: live placement on the Pipeline page; blocks today's flow does not use
   (pinned and capped agents, park, check). An agent
   block's `slots` counts its running tasks from placement, and each block
   has a dispatcher test on a drawn pipeline.
