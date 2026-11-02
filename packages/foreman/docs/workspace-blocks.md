# Workspace blocks: where agents work

Status: approved by the operator on 2026-11-02. It replaces the per-project
`checkout` policy setting. Where agents work is a set of pipeline blocks, not a
policy setting.

## Blocks

- **branch**: makes the task's branch `foreman/<id>` from the trunk tip. It runs
  no agent.
- **worktree**: checks the task's branch out in a separate directory. It runs no
  agent. It needs a branch block before it.
- **land**: puts the approved commit onto the trunk. Prop `how`: `merge` (a merge
  commit; the default) or `fast-forward`. It needs a branch block before it.
  After landing it removes the worktree and the branch, or gives your checkout
  back.
- **done**: completes the task. It is the end of a route with no branch, which
  has nothing to land.

Agents work where the blocks before them put the task:

| Blocks before the agent | The agent works in | On |
|---|---|---|
| branch, worktree | a separate worktree | the task's branch (the standard pipeline) |
| branch | your checkout | the task's branch |
| none | your checkout | your current branch ("direct") |

## Rules

1. **Work that cannot land is a pipeline problem.** Every route from a branch
   block reaches a land block or a park block. Validation names a route that does
   not: "work on this branch never lands". A land with no branch before it is a
   problem too.
2. **Your checkout holds one task at a time.** A task without a worktree occupies
   your checkout from its first block that uses it until it leaves the pipeline.
   The planner marks the checkout taken as soon as it plans that dispatch, so one
   tick cannot send two tasks into it.
3. **Passing a workspace block is read from git, not recorded.** A task whose
   branch exists has passed the branch block; one whose worktree exists has
   passed the worktree block. So tasks in flight place correctly with no
   back-fill.
4. **Direct has no undo.** With no branch, a returned review leaves the author's
   commits on your branch, and the next author continues on top of them. Foreman
   cannot separate them from commits you made meanwhile.
5. **A direct task completes when it passes the last block.** It has nothing to
   land, so its route ends at the **done** block.

## How the engine reads the blocks

- **branch and worktree are walked through, like gates.** Placement does not stop
  at them. It records the workspace shape on the work block where the task
  stands: none, branch, or branch and worktree. An agent's dispatch makes what is
  missing: the branch from the trunk tip, then the worktree. git is the record
  (rule 3): `Fleet.open` adopts a worktree git lists for the branch, and a branch
  that exists is not made again. So placement stays a function of the task's
  facts, and no tick makes a branch for a task that no gate has let start.
- **Occupancy of your checkout is derived every tick.** A task occupies the
  checkout when its route has no worktree, an author has run on it, and it is
  still in the pipeline. git's busy hold (a `foreman/*` branch out in the
  checkout) is the same fact for a branch-only task. The planner starts each pass
  with that set and adds the project when it plans a dispatch into the checkout.
  A dispatch into the checkout also needs a clean tree.
- **done and land are work blocks for validation.** Nothing reaches a done or a
  land without a review after the last source or author, and a gate stands
  before each. So a direct route cannot complete without review or a policy
  stop.
- **Fast-forward lands only a commit that descends from the trunk tip.** A trunk
  that moved after the branch was cut returns the task to the queue at the same
  rung, as a conflict does. Foreman never rebases: a rebase makes a commit the
  reviewer did not read.
- **Empty-branch detection reads the branch's own history.** After a fast-forward
  landing the tip is on the trunk's first-parent line, so "the tip is on the
  first-parent line" no longer means "nothing was committed".
- **A direct review reads the commits since the author started.** The author run
  records the trunk tip when it opens, and the reviewer diffs from it.

## Changes to what exists

- The standard pipeline is: source → branch → worktree → retry router → author →
  review → land (merge).
- Each saved pipeline gets branch → worktree inserted after its sources, once.
  The pipelines file records that it was done, so a pipeline the operator later
  makes direct stays direct.
- The policy `checkout` setting and its CLI command are removed. Its git code
  stays: leaving the task's branch before landing, merging the approved commit by
  id, and giving the checkout back.
