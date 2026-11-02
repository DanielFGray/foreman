# Pipelines: foreman runs a wired graph of blocks

Status: design, under review with the operator. Prototype: branch
`prototype/pipeline-editor`.

## What changes

Today the dispatcher runs one flow, written into `settle`, `fill` and `land`:
queue → author → review → land. A **pipeline** makes that flow data. Each
project has one: a graph of **blocks** (nodes) joined by **wires**. The
dispatcher places each task in the graph and runs the block it stands at. With
no pipeline set, a project runs the **standard pipeline**, which is today's flow,
so nothing changes until the operator draws one.

The executors stay: dispatching an agent into the task's worktree, reading how
its run ended, landing, usage walls, trials, teardown. What the pipeline
replaces is the fixed answer to "which step does this task take next".

## Where things live

| Question | Answered by |
| --- | --- |
| What does this project's flow look like? | its entry in `pipelines.json` beside the policy file, else the standard pipeline |
| Where is this task in it? | derived every tick by `place` from the task's facts |
| Which blocks has it passed? | a fact: the `node` of each run in the current lap that advanced the task |
| May this step run for this task? | the policy: the gate's step, its mode, grants (unchanged) |

The pipeline is operator intention. It lives in its own file, `pipelines.json`
(`$FOREMAN_PIPELINES` overrides), in the policy file's directory: the
dispatcher already watches that directory, because writes replace a file by
rename, so one watch sees a change to either file. Both files are written
through `rewrite` in `src/shared-file.ts`.

A task's position is not stored. `place` replays the graph from the source with
the task's **facts** each tick (status, priority, epic, size, the rungs that
failed it, its attempts, the blocks it passed, its review state), the same way the ladder reads `failed-by` labels
instead of storing the next rung. A run's `node` records a fact (the task went
through that block), so it does not rot: if the operator deletes the node, the
run places nothing and the task is placed by what remains.

## The graph has no return wires

Every block has at most one forward wire. Work that goes back is not wired: it
**returns**. A return releases the task to the queue; its next author run starts a
new lap, so the blocks it passed no longer count. It keeps the evidence it
earned (`failed-by`, `attempt`). The task then
re-enters at a source, and routers send it on by that evidence.

This is the doctrine "a task records what failed it, never what runs next",
applied to the graph. A wire from "rejected" to a chosen block would be a
pointer to what runs next. A router at the entry that reads `failed-by` reaches
the same block from evidence, and stays correct when the graph is edited.

So the graph is acyclic, and every path from a source ends at a land block or a
park.

## Blocks

| Kind | Props | Forward | Runs |
| --- | --- | --- | --- |
| source | `filter` | `next` | Ready tasks in queue order that match the filter. A task enters the first source that matches. |
| router | `routes: [{when, to}]`, `else` | per route | Instant. The first route whose filter matches. |
| gate | `step` | `next` | Holds the task before the next work block until the policy permits `step` for it. `ask` lists it for approval. |
| agent | `role`, `model`, `slots?` | `next` | A work block. Dispatches an agent and waits for its run to end. |
| land | — | (ends) | A work block. Today's `land`. Landing completes the task. |
| park | — | (ends) | Parks the task for the operator (`needs-you`). |
| check | `command` | `next` | A work block (stage 4). Runs a command in the task's worktree. |

A **work block** is one that runs something and takes time: agent, check, land.
Sources, routers and gates decide at once.

### How each work block ends a run

| Block | Advances when | Returns when |
| --- | --- | --- |
| author agent | the author hands off committed work (status `reviewing`) | it stops unfinished or hands back an empty branch (`unfinished`: an attempt, and `failed-by` once the rung is spent) |
| review agent | the reviewer's verdict is `approved` and the branch tip is still the commit it read | the reviewer sends it back (`climb`: `failed-by` the author's rung) |
| land | the merge lands (the task is done) | a conflict (no evidence) or broken verification (`climb`) |

A reviewer that stops without a verdict while a rung is left, a usage wall, a
blocked agent and a dirty checkout are not endings: the task stays at the block,
as today. Every rung failed, or no reviewer left, parks the task, as today.

When settle sees a block advance, the run that advanced it is the record: its
`node` and its ending. An agent reports its ending with `tasks verdict`
(`runs-replace-labels.md`), so no label carries a signal and nothing clears one.

### A review passes one commit

A review run records the commit it read: the branch tip when the run opened.
The review block counts as passed only while the branch tip is still that
commit. A commit after the review opened (the author's, a repair's, or the
operator's by hand) places the task at the review block again, and no code
clears anything to make that happen. Land checks the tip once more, then merges
the recorded commit by its id, never the branch name, so what lands is exactly
what the reviewer read. A tip that moved in between sends the task back to the
review block; landing the older commit would close the task and strand the
newer one.

This replaces today's rule that every transition which hands a task back must
clear `approved` (`Prog.release`, `review`, `submit`, `clearReview`). That rule
holds only while every path remembers it; a recorded commit holds by itself.
`Held` still keeps a verdict: the tip has not moved, so the review still passes.

### Models

`model` is `ladder` (author: the cheapest rung above the task's failures),
`above` (review: the next rung above the author and any failed reviewers), or a
rung name (pinned). A pinned block that has a `failed-by` for its rung has no
rung left, so the task parks. A router in front of it is how a pipeline sends
such a task elsewhere. `slots` caps how many of the block's tasks run at once,
inside the fleet's `slots`.

### Filters

A filter is a list of terms; all must match. A `-` in front negates a term.
Filters read facts, never label strings, so when runs replace labels only
`factsOf` changes.

- `label:<name>`: a person set the label (for example `research`).
- `epic:<id>`: the task's parent epic.
- `failed`: any rung failed it. `failed:<rung>`: that rung did.
- `size`, `priority` or `attempts` compared with `<=`, `>=` or `=` to a whole
  number (`size` is 1 when unset).

## Placement

`place(pipeline, task)` is a pure function:

1. Start at the first source whose filter matches the task. No match: the task
   is not in this pipeline.
2. Walk forward. At a router, follow the first matching route. At a gate,
   remember the gate. At a work block that a run of this lap advanced,
   forget the remembered gates and go on.
3. Stop at the first work block not passed. The task is **at** that block. Its
   state there comes from its status and its runs:
   - `waiting`: nothing runs yet. The remembered gates decide when it may start.
   - `running`: the block's run is open and its agent is working.
   - `ended`: the agent ended its run (an author handed off, or a reviewer
     wrote its verdict), and settle has not closed the run yet.
     Settle closes it, and the walk goes on.
4. A park ends the walk with the task parked.

A task with work in flight when pipelines start has runs from step 4, so it is
placed by the same steps. No move-in step is needed.

## The tick

The passes keep their order and their reasons. Only a running fleet acts, and
settle comes before fill.

1. **Read**, unchanged. The pipeline comes with the policy.
2. **Settle.** For each owned task, classify the run's end as today (`phaseOf`,
   the merge result). An advance closes the run. A return does today's
   bookkeeping and releases the task.
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
- At least one source. Every wire ends at a block. Every block is reachable from
  a source.
- No cycle.
- Every path ends at a land or a park.
- **Every path to a land passes a review agent after its last author.** With
  the reviewers taken out of the graph, no land is reachable from a source or
  an author.
- Every agent has a gate on each path into it, and so does every land. With
  the gates taken out, and the walk halted at each work block, no work block
  is reachable from a source or from the work block before it. A step that
  spends without a policy step would be one the operator cannot stop.

Both are reachability checks with `effect/Graph`, which also finds cycles and
draws the pipeline as Mermaid (`foreman pipeline show`).

## The standard pipeline

```
source(all)
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
  one durable thing foreman holds": changed. The operator's intention is in two
  files, the policy and the pipelines, written the same way.
- "Nothing skips review": kept, and enforced by validation.
- "Order inside a tick ... reviews are filled before new work": generalised to
  nearest-to-the-end first. Same order in the standard pipeline.
- "`awaitingLanding` reads that label": becomes "placed at a land block".
  The reviewer's `tasks verdict` writes the review run's ending; the run and
  its commit are the record.
- "Approval is a durable `approved` label … any transition handing the task
  back … must clear it" and "`Prog.release` therefore clears it alongside
  `approved`": replaced at step 4. A review passes the commit it read, and a
  moved tip voids it (see "A review passes one commit"). `review-by:*` and
  `review-failed-by:*` go with the labels; the review run's open and close
  replace them.
- "`satisfied` is cleared wherever `approved` is": replaced. `satisfied` is the
  ending of an author run (`runs-replace-labels.md`).
- "`Held` … leaves the task in `reviewing` with its `approved` label": kept in
  meaning. The tip has not moved, so the review still passes.

## Build order

Each stage keeps every existing test green and commits after the gate. The work
is on a feature branch in its own worktree, because the live dispatcher runs
from the main checkout and lands into `develop` there.

1. Done: `src/pipeline.ts`: schema, facts, filters, placement, validation,
   Mermaid, the standard pipeline.
2. Done: `pipelines.json` and `foreman pipeline show|check|set|clear`.
3. Done: herdr-web's Pipeline page: the editor. It draws, checks and saves
   through foreman's commands, and needs nothing from the dispatcher.
4. Runs replace labels (tasks step 3b; design in `runs-replace-labels.md`); `factsOf` reads runs and each task's
   branch tip. A review run records the commit it read, and land merges that
   commit by id. Pass criterion: a commit to an approved branch places the task
   at the review block again, with no clearing code on any path; land refuses a
   tip other than the recorded commit; the code that clears `approved` on
   requeue is gone.
5. The dispatcher runs the standard pipeline through `place`. Pass criterion:
   the dispatcher tests pass with no test edited, a table test maps each
   `TaskPhase` and merge verdict to its old and its placed next step, and
   placement of the live tasks matches today's working, review and queue views.
6. Live placement on the Pipeline page; blocks today's flow does not use
   (pinned and capped agents, park, check).
