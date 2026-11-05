# Workspace blocks: where agents work

Where agents work is a set of pipeline blocks. The project's pipeline draws the
blocks, and the policy does not hold a workspace setting.

## Blocks

- **branch**: makes the task's branch `foreman/<id>` from the tip of its target:
  the branch the lands after it name with `onto`, else the branch your checkout
  has out. It runs no agent.
- **worktree**: checks the task's branch out in a separate directory. It runs no
  agent. It needs a branch block before it.
- **land**: puts the approved commit onto its target. Prop `onto`: the branch it
  lands on; absent is the branch your checkout has out. Prop `how`: `merge` (a
  merge commit; the default), `fast-forward`, or `pull-request`. A pull-request
  land makes foreman push the branch, open a pull request, and merge it on GitHub
  once the repo's required checks pass. A pull-request land needs a `publish` gate
  and a `land` gate before it (`docs/pipeline-engine.md`, Validation). The local
  proving ground does not run for it. It needs a branch block before it.
  After landing, foreman removes the worktree and the branch, or gives your
  checkout back.
- **done**: completes the task. It is the end of a route with no branch, which
  has nothing to land.

Agents work where the blocks before them put the task:

| Blocks before the agent | The agent works in | On |
|---|---|---|
| branch, worktree | a separate worktree | the task's branch (`worktree`) |
| branch | your checkout | the task's branch (`checkout`, the default) |
| none | your checkout | your current branch (`direct`) |

A project with no drawn pipeline runs the `checkout` choice. `foreman pipeline
use <checkout|worktree|direct> [--land merge|fast-forward|pull-request] [--onto
<branch>] --project <name>` draws the standard pipeline of that workspace as the
project's pipeline, through the same file code as the pipeline editor. `--land`
is the land's `how` (default `merge`). `--onto` is its `onto` (default none: the
branch your checkout has out). A pull-request land comes with its publish gate.
A direct route lands nothing, so `use direct` refuses `--land` and `--onto`. It
also refuses when the project already has a drawing that is no standard pipeline,
so a hand-drawn pipeline is never lost.

A worktree task can be served for a look. `foreman preview <task>` runs the
project's `scripts/preview.sh` in the task's worktree, in the hc terminal
`preview-<task>`, and prints that terminal's address. A preview terminal that is
still live is used again. The `preview` action shows only on a row whose task has
a worktree, in a project that keeps the script. A task in your checkout needs no
preview: your own dev server serves it.

## Rules

1. **Work that cannot land is a pipeline problem.** Every route from a branch
   block reaches a land block or a park block. Validation names a route that does
   not: "work on this branch never lands". A land with no branch before it is a
   problem too.
2. **Your checkout holds one task at a time.** A task holds your checkout while
   its commits sit there. A task on a branch holds it while git has its branch
   out in the checkout: from its author's dispatch until it lands or goes back
   to the queue, which checks your branch out again. A direct task holds it from
   its first author run there until it leaves the pipeline, because its commits
   are on your branch with no undo (rule 4). The planner marks the checkout
   taken as soon as it plans that dispatch, so one tick cannot send two tasks
   into it.
3. **Passing a workspace block is read from git, not recorded.** A task whose
   branch exists has passed the branch block. A task whose worktree exists has
   passed the worktree block. So tasks in flight place correctly with no
   back-fill.
4. **Direct has no undo.** With no branch, a returned review leaves the author's
   commits on your branch, and the next author continues on top of them. Foreman
   cannot separate them from commits you made meanwhile.
5. **A task lands on one branch, fixed when its branch is cut.** Every land a
   branch block reaches names the same `onto` (absent counts as one target), or
   validation names the blocks. An `onto` that names a `foreman/` branch is a
   problem too. The branch block records the target as the task branch's git
   upstream. The pull request's base, the reviewer's base, the sweep's `merged`
   and `empty`, and the landing all read that upstream. A drawing edit applies to
   branches cut after it. With no `onto`, the branch records the branch your
   checkout has out when it is cut. A branch with no upstream has no target. Its
   landing holds with a reason that names it. Its review and pull request cannot
   start, and the sweep reads it as work. A direct route has no land and stays on
   your branch.
6. **A target that does not exist holds the project.** The held row names the
   target, at dispatch and at landing. A route in your checkout with no worktree
   (branch only) leaves the task's branch by checking its upstream out. So the
   checkout must have the target out to start one. Otherwise the project is held,
   and the row names both branches. Foreman never moves your checkout to a branch
   you were not on.

## How the engine reads the blocks

- **branch and worktree are walked through, like gates.** Placement does not stop
  at them. `routeWorkspace` reads the shape from the task's route: none, branch,
  or branch and worktree. An agent's dispatch makes what is missing: the branch
  from the trunk tip, then the worktree. git is the record (rule 3). `Fleet.open`
  adopts a worktree that git lists for the branch, and a branch that exists is not
  made again. So placement stays a function of the task's facts. No tick makes a
  branch for a task that no gate has let start.
- **Occupancy of your checkout is read every tick.** For a task on a branch, it
  is git's busy hold: a `foreman/*` branch out in the checkout. A direct task has
  no branch to read. It occupies the checkout when its route is direct, an author
  run recorded a `base` there, and it is still in the pipeline. An author run with
  no `base` worked in a worktree or on a branch, and holds nothing. The planner
  starts each pass with these holds, and adds the project when it plans a dispatch
  into the checkout. A dispatch into the checkout also needs a clean tree.
- **done and land are work blocks for validation.** Nothing reaches a done or a
  land without a review after the last source or author, and a gate stands before
  each. So a direct route cannot complete without review or a policy stop.
- **A landing applies the proved commit by the target's ref.** The proving ground
  resets to the target's tip. A target your checkout has out is fast-forwarded
  there. Your uncommitted edits hold only the landings that write the same paths.
  A target out nowhere is moved with `git update-ref refs/heads/<onto> <proved>
  <old tip>`, which fails when the tip moved. So your checkout is not touched, and
  its edits hold nothing. A target that another worktree has out is fast-forwarded
  in that worktree. A tip that moved during the proof holds the landing, and a
  later tick proves it again.
- **Fast-forward lands only a commit that descends from the target's tip.** A
  target that moved after the branch was cut returns the task to the queue at the
  same rung, as a conflict does. Foreman never rebases: a rebase makes a commit
  the reviewer did not read.
- **Empty-branch detection reads the branch's own history.** After a fast-forward
  landing, the tip can be on the trunk's first-parent line and still contain
  commits from the task branch.
- **A direct review reads the commits since the first author started.** Each
  direct author run records the checkout's HEAD as its `base` when it opens. The
  reviewer diffs from the first such base (rule 4). The task's tip is the
  checkout's HEAD while it occupies the checkout. A tip past that base is the
  author's commit.
