# Pipelines: foreman runs a wired graph of blocks

A **pipeline** is the flow each project runs. It is a graph of **blocks**
(nodes) joined by **wires**. The dispatcher places each task in the graph and
runs the block where the task stands. A project with no pipeline runs the
**default pipeline**: the standard pipeline in the operator's checkout, on the
task's branch. `foreman pipeline use <checkout|worktree|direct> [--land
merge|fast-forward|pull-request] [--onto <branch>] --project <name>` draws a
standard pipeline (`docs/workspace-blocks.md`).

The executors do the work inside a block: dispatching an agent into the task's
worktree, reading how its run ended, landing, usage walls, trials and teardown.
The pipeline decides which block a task takes next.

## Where things live

| Question | Answered by |
| --- | --- |
| What does this project's flow look like? | its entry in `pipelines.json` beside the policy file, else the default pipeline |
| Where is this task in it? | derived every tick by `place` from the task's facts |
| Which block did it last leave? | a fact: the exit its last named run named, and the commit it was named on |
| May this step run for this task? | the policy: the gate's step, its mode, grants |

The pipeline is operator intention. It lives in its own file, `pipelines.json`
(`$FOREMAN_PIPELINES` overrides), in the policy file's directory. The dispatcher
watches that directory, because writes replace a file by rename, so one watch
sees a change to either file. Both files are written through `rewrite` in
`src/shared-file.ts`.

A task's position is not stored. `place` replays the graph from the source with
the task's **facts** each tick: status, priority, epic, size, the rungs that
failed it, its attempts, and the exits it named. The ladder works the same way:
it reads `failed-by` evidence and stores no next rung. A run's `node` and its
exit record a fact, the exit that the agent at that block named. If the operator
deletes the block or the exit, the run places nothing and the task starts at its
source again.

## Exits

An agent or a check ends its run by naming an **exit**. Each exit is a wire to
the block that comes next, or to `queue`. An agent names its exit with
`foreman exit <task> <name>`. foreman names a check's `passed` or `failed`. A
run that stops with no exit has a **process ending**: `stopped`, `vanished`,
`walled`, `released` or `canceled`.

An exit to `queue` is a **return**. It releases the task to the queue and keeps
the evidence the task earned (`failed-by`, `attempt`). The task then re-enters
at a source, and routers send it on by that evidence.

The doctrine is that a task records what failed it, never what runs next. The
exit is evidence of what the agent said. Its wire is read from the drawing as
it is now, so an edit to the wire moves the task.

An exit may wire back to an earlier block, so the graph may hold a cycle.
Validation refuses a cycle that cannot end. In the standard pipeline, a returned
review follows a cycle through the `climb` gate to the next author, and keeps
the claim and the workspace. See "The standard pipeline, drawn with exits" in
`agent-exits.md`. A saved pipeline keeps its drawn returns to the queue.

## Blocks

| Kind | Props | Forward | Runs |
| --- | --- | --- | --- |
| source | `filter` | `next` | Ready tasks in queue order that match the filter. A task enters the first source that matches. |
| router | `routes: [{when, to}]`, `else` | per route | Instant. The first route whose filter matches. |
| gate | `step` | `next` | Holds the task before the next work block until the policy permits `step` for it. `ask` lists it for approval. |
| branch | — | `next` | Instant. Makes `foreman/<id>` from the trunk tip when the first agent is dispatched. git records it as passed. |
| worktree | — | `next` | Instant. Puts the task's branch in a directory of its own. Without one, agents work in the operator's checkout. See `docs/workspace-blocks.md`. |
| agent | `role`, `model`, `slots?`, `stopped?` | `exits` | A work block. Dispatches an agent and waits for it to name an exit or stop. |
| land | `how?`: `merge` (default), `fast-forward` or `pull-request`; `onto?`: the branch it lands on, absent for the branch the checkout has out | (ends) | A work block. Lands the approved commit on `onto`, which completes the task. |
| done | — | (ends) | A work block. Completes a task that has no branch: its commits are already on the operator's branch. |
| park | — | (ends) | Parks the task for the operator (a row in `parks`). |
| check | `command` | `exits`: `passed`, `failed` | A work block. Runs `command` on the task's branch tip, in the project's proving ground. Takes no slot. |
| composite | `of`, `prefix`, `set`, `exits: [{id, to}]` | `exits` by id | An instance of a saved composite definition. Expansion replaces it with the definition's blocks before every reader runs, validates, places or traces (`docs/composite-blocks.md`). |

A **work block** runs something and takes time: agent, check, land, done.
Sources, routers, gates, branches and worktrees decide at once. A composite is
not a work block: readers see only its expansion.

### How each work block ends a run

| Block | Advances when | Returns when |
| --- | --- | --- |
| author agent | the author names `done` or its claim (`already-done`). The task stays `in_progress`, and placement follows the exit. | it stops with no exit, or hands back an empty branch (`stopped: retry`: an attempt, and `failed-by` once the rung is spent) |
| review agent | the reviewer names `approved` and the branch tip is still the commit it named | the reviewer names `returned` (`fails: author`: `failed-by` the author's rung) |
| land | the merge lands, and the task is done | a conflict (no evidence) or broken verification (`climb`) |
| done | the approval holds for the checkout's HEAD, and the task is done | — |
| check | `passed`: `command` exits 0 on the branch tip, or fails at the commit the branch was cut from as well | `failed`: `command` fails twice on the tip and passes where the branch was cut (`fails: author`, with the output in the task's log) |

This table is the standard wiring. An operator may wire any exit to any block
or to `queue`. An exit with `fails: author` charges the rung of the task's last
author run. An exit with `fails: self` charges the author block's own rung.

A stop with no exit follows the agent block's `stopped`. `retry` (the default)
keeps the task at the block, so a reviewer that stops while another reviewer
is left tries again on that one. `park` parks the task. A usage wall, a blocked
agent and a dirty checkout are not endings: the task stays at the block. When
every rung has failed, or no reviewer is left, the task parks.

The run that named the exit is the record: its `node`, its exit and the commit
it was named on.

### A review passes one commit

`foreman exit` records the commit the exit was named on. That is the task's tip
on its route: the branch tip, or the checkout's HEAD on a direct route. The exit
holds only while the tip is still that commit. A correction round needs no
special case: the reviewer names its exit after the round, on the new tip. A
commit after the review opened (the author's, a repair's, or the operator's by
hand) places the task at the review block again. Nothing clears a label to make
that happen.

Land checks the tip once more, then merges the recorded commit by its id, never
the branch name. So what lands is exactly what the reviewer read. If the tip has
moved, the task goes back to the review block. Landing the older commit would
close the task and strand the newer one.

`Held` keeps an `approved` exit. The tip has not moved, so the exit still holds.

### A check passes one commit

A check runs its command where landing runs verify: in the project's proving
ground, checked out at the branch tip. It judges exactly that commit and writes
to no tree that a person or an agent uses. A failure is retried once, as a
flake. Then the command runs where the branch was cut from its trunk. A command
red there too says nothing about the branch, so the check passes with a note in
the task's log. A ground that is not ready, or a tip that moved while the command
ran, records nothing. A later tick checks again.

The command runs inside the tick, as verify does. A slow command delays
everything else that tick does, once per commit at each check.

The check records a run with the commit it ran on and the exit `passed` or
`failed`. The run names no model, and the views about models leave it out. Like
a review's exit, the check holds only while the branch tip is still that commit.
A later commit places the task at the check again.

The policy has no step of its own for a check. The gate before a check names one
of the existing steps.

### Models

`model` is, for an author, `ladder` or a rung name that may author (pinned).
`ladder` takes the lowest level above every level with a rung the task failed,
and inside that level the author-on rung whose run started least recently.
A pinned author block with a `failed-by` for its rung has no rung left, so the
task parks.

For a reviewer, `model` is `reviewers` or one reviewer's name. `reviewers` takes
the reviewer whose last review started longest ago. It skips a reviewer on a
spent account, and it prefers a model other than the author's. A reviewer that
stopped this lap with no verdict is passed over. With none left, the task parks.

The drawing check refuses a name that is no reviewer. It also refuses `ladder`
on a reviewer block and `reviewers` on an author block. A router in front of a
block sends a task elsewhere. `slots` caps how many of the block's tasks run at
once, inside the fleet's `slots`.

### Filters

A filter is a list of terms. All must match. A `-` in front negates a term.
Filters read facts. They never read label strings, except `label:<name>`, which
reads a label a person set.

- `label:<name>`: a person set the label (for example `research`).
- `epic:<id>`: the task's parent epic.
- `failed`: any rung failed it. `failed:<rung>`: that rung did.
- `exit:<name>`: the task's last exit was `<name>`.
- `size`, `priority`, `attempts` or `exits:<name>` compared with `<=`, `>=` or
  `=` to a whole number. `size` is 1 when unset. `exits:<name>` counts the times
  the task named that exit since it last left a source. A return counts as
  leaving.
- `exit:<block>/<name>` and `exits:<block>/<name>` read only the exits named at
  `<block>`, so two instances of one composite are told apart
  (`composite-blocks.md`).

## Placement

`place(pipeline, task)` is a pure function:

1. Start at the first source whose filter matches the task. No match: the task
   is not in this pipeline.
2. A task with an open agent run is **at** that run's block: `ended` when the
   run named an exit, else `running`. Settle closes an ended run once the
   agent's pane is idle. The next tick places the task where the exit leads.
3. Otherwise take the task's last named exit, find its id on its block in the
   drawing as it is now, and walk from its wire. An open task, a return or no
   exit at all: walk from the source. A missing block or exit is `ExitGone`, a
   decision for the operator.
4. Walk forward. At a router, follow the first matching route. At a gate,
   remember the gate. Stop at the first work block. The task is **at** that
   block, `waiting`. The remembered gates decide when it may start. The walk has
   a step bound, so a cycle of routers cannot hang it.
5. **An exit holds for the commit it was named on.** When the walk reaches a
   land or a done, or the exit was named at a check, and the tip is not that
   commit, the exit is void. The task is placed by the exit before it. So a
   commit after `approved` places the task at the review again.
   A land or a check is always `waiting`. Each runs inside one tick and leaves
   no open run.
6. A park ends the walk with the task parked.

## The tick

The passes keep their order and their reasons. Only a running fleet acts, and
settle comes before fill.

1. **Read.** The pipeline comes with the policy.
2. **Settle.** For each owned task, classify the run's end (`phaseOf`, the merge
   result). An advance closes the run. A return does the release bookkeeping and
   releases the task. The landings and checks the last plan holds run here, one
   at a time, landings first: they share the project's proving ground.
3. **Plan.** Place every queued and owned task. A task `waiting` at a work block
   is a candidate when every remembered gate permits it. A gate in `ask` mode
   gives an ask. Candidates are taken nearest to the end first (fewest work
   blocks left), then in queue order. So reviews come before new work, in any
   graph.
4. **Fill**, **tidy**, **reclaim** and **recover** run after the plan.

## Runs

The `runs` table records each agent run and each check. Each row is one run. A
run opens when foreman dispatches its agent and closes when settle sees it end.
Facts about what a run did come from its row. No label records them.

- `node`: the pipeline block the run ran at.
- `commit`: for an agent run, the commit its exit was named on, or the branch tip
  when it closed. For a check, the tip it ran on.
- `ending`: how the run stopped. An agent's exit name, or a process ending. For a
  check, `passed` or `failed`.
- `outcome`: what became of the run's work: `committed`, `dropped`,
  `handed-off` or `answered`. Settle maps the ending to an outcome when the run
  closes. Landing sets the lap's author run to `committed`, or to `answered` for
  research.
- `rounds`: the correction rounds the run received.

### The lap

A **lap** is the task's latest author run and every run after it. The review
facts read only the current lap:

- `reviewedBy`: the lap's open review run.
- `reviewFailedBy`: the lap's review runs that ended with no verdict.
- `isApproved`: the lap's last review run has an approved verdict, and its
  `commit` is the branch tip now.
- `authoredBy`: the rung of the task's latest author run.

A new author run starts a new lap, so the last lap's reviews fall out of scope.
No code clears them.

### The verdict

An agent states how its run ended with `tasks verdict <task>
approved|returned|already-done`. The command writes the ending on the task's
open run of the matching work, and makes the status change that goes with it in
the same transaction:

- `approved` and `returned` apply to a review run. `returned` reopens the task
  when its wire goes to the queue. Otherwise the task stays `in_progress`, and
  placement reads the step from the exit.
- `already-done` applies to an author run. The task stays `in_progress` at the
  review step.
- A second verdict on the same run overwrites the first.

A verdict cannot change a closed run. Settle closes the run, so no open run
remains to take it.

### Writes

- Dispatch an author: open an author run with its rung, model, pool and node.
- Dispatch a reviewer: open a review run with `commit` set to the branch tip.
- A spawn that fails deletes the open run in the same transaction that releases
  the task. The agent never ran, so the run never happened.
- A correction round (`foreman correct`) adds one to the `rounds` of the lap's
  author run. That run has usually closed `handed-off`, because the author's work
  is in review.
- Settle closes the run and keeps the agent's ending if the agent wrote one.
  Otherwise settle writes its own. An author run that hands off records the tip
  as `commit`.
- Landing sets the lap's author run outcome in the transaction that completes
  the task.
- `foreman unassign <id>` closes an open review run that no reviewer is
  behind, as `released`. It charges no rung.

Run reads and writes live in `packages/tasks/src/runs.ts`. The store's CLI
commands and the dispatcher share them.

### Labels that remain

The ladder reads these labels. They answer which rungs may author next:

- `failed-by:<rung>`, `attempt:<rung>:<n>` and `walled:<provider>`.

An operator corrects them by hand (`clearFailure`, and a pin, which marks every
rung below it failed). No run stands behind a correction, because the runs table
is the model registry that `model_summary` reads. A row written for a correction
would count as a run.

These labels record a fact a person sets. Foreman reads them, and no run writes
them:

- `needs-you`, `diagnosing:<intent>`, `research`, `onboard`, `size:<n>`, `bug`.

## Validation

A pipeline that fails validation is not run. The reading says why, and the
project takes no step. It never falls back to the standard pipeline, because
running a flow the operator did not draw is worse than stopping.

- Block kinds and props as above, including `composite`. A block id holds no
  `/`, which separates a block from its port in wires and filters. Pinned
  rungs are on the ladder. Validation runs on the expansion: an unknown
  definition, an unwired exit, a missing parameter or a recursion is a problem
  of that project only.
- At least one source. Every wire and every exit ends at a block or `queue`.
  Every block is reachable from a source. From every block, some route reaches
  a land, a done or a park.
- An agent block declares at least one exit. Exit names are unique on their
  block, match `[a-z-]+`, and are not process endings. A check's exits are
  `passed` and `failed`. `fails: self` is refused on a check, because a check has
  no rung. A review block refuses `fails: self` too, because a reviewer is no
  rung.
- Every lap of every cycle can end. Each lap passes an exit that has `fails`, or
  a router that leaves on a count that grows each lap (`exits:<name>>=N` or
  `attempts>=N`). A smaller loop inside a cycle that passes neither is a problem,
  even when the larger cycle charges. A cycle through no work block is a problem.
- A router filter that counts an exit (`exit:<name>` or `exits:<name>>=N`)
  names an exit some block declares, or a process ending. With a block
  (`exits:<block>/<name>>=N`), that block exists and declares it. A count with a
  block grows each lap only when that block is on the cycle. A rename or a removal
  that leaves the filter counting nothing is a problem.
- Every path to a land or a done passes a review agent after its last author.
  With the reviewers taken out of the graph, no land or done is reachable from a
  source or an author.
- A path from a branch ends at a land or a park, never at a done. Work on a
  branch must land. A worktree or a land needs a branch before it on every path.
  No branch or worktree stands after an agent or a check.
- Every agent has a gate on each path into it. So does every check, land and
  done. With the gates taken out, and the walk halted at each work block, no work
  block is reachable from a source or from the work block before it. A step that
  spends without a policy step is one the operator cannot stop.
- Every path to a check passes an author first. A check before any author runs on
  a branch with no work. A check is not a review, so a land after a check still
  needs a review after its last author.
- A check names a command.
- A pull-request land (`how: pull-request`) takes two gates on every path into
  it after the last agent or check. A `publish` gate pushes and opens the pull
  request. A `land` gate merges it. Either step can be on while the other is off,
  so one gate cannot stand for both. A `publish` gate from which no route reaches
  a pull-request land is a problem, because it would hold a step that never comes.
  A change of a land's `how` brings these gates with it, in one change. To
  `pull-request`, a gate of each step that a route to the land lacks goes
  directly before the land. Away from `pull-request`, each publish gate that
  reached a pull-request land, and reaches none after the change, is removed. Its
  wires run on to its next block (`configure` in `src/pipeline-belt.ts`).
- Every land that a branch block reaches names the same `onto`. An absent `onto`
  counts as one target, because the branch block cuts the task's branch from that
  target. An `onto` that is empty, or names a `foreman/` branch, is a problem
  (`docs/workspace-blocks.md`, rule 5).

These are reachability checks with `effect/Graph`. The same graph finds cycles and
draws the pipeline as Mermaid (`foreman pipeline show`).

## The standard pipeline

The standard pipeline takes a workspace and, for a route on a branch, a landing:
`standardPipeline` in `src/pipeline.ts`. The blocks between the source and the
router say where the agents work:

- `branch`: the operator's checkout. This is the default.
- `branch → worktree`: a worktree.
- none: direct. Direct ends at `done` in place of `land`, so it takes no landing.

The other two end at a land with the `how` and `onto` given. The default is
`merge` with no `onto`. A pull-request land takes a publish gate between its land
gate and itself.

```
source(all) → workspace blocks
  → router: failed      → gate(climb)
            attempts>=1 → gate(climb)
            else        → gate(author)
gate(author), gate(climb) → agent(author, ladder)
  → gate(review) → agent(review, above)
  → gate(land) → [gate(publish), pull-request only] → land
```

A pipeline is standard when it holds the same blocks as the standard pipeline of
its own workspace blocks and land, in any order (`standardOf`). `standardOf`
reads the pipeline as written, so a pipeline with a composite instance is not
standard, and `pipeline use` does not rewrite it. `pipeline show` names a
standard drawing. `pipeline use` rewrites only a standard pipeline.

The router is `authorStep` in `src/policy.ts`, drawn as a block. A conflict
returns with no evidence. So the router reads the same labels as before, and the
policy step that holds the retry is unchanged.
