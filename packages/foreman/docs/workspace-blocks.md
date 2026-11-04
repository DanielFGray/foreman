# Workspace blocks: where agents work

Status: approved by the operator on 2026-11-02. It replaces the per-project
`checkout` policy setting. Where agents work is a set of pipeline blocks, not a
policy setting.

## Blocks

- **branch**: makes the task's branch `foreman/<id>` from the tip of its target:
  the branch the lands after it name with `onto`, else the branch your checkout
  has out. It runs no agent.
- **worktree**: checks the task's branch out in a separate directory. It runs no
  agent. It needs a branch block before it.
- **land**: puts the approved commit onto its target. Prop `onto`: the branch it
  lands on; absent is the branch your checkout has out. Prop `how`: `merge` (a merge
  commit; the default), `fast-forward`, or `pull-request`: foreman pushes the
  branch, opens a pull request, and merges it on GitHub once the repo's required
  checks pass. A pull-request land needs a `publish` gate and a `land` gate
  before it (`docs/pipeline-engine.md`, Validation), and the local proving ground
  does not run for it. It needs a branch block before it.
  After landing it removes the worktree and the branch, or gives your checkout
  back.
- **done**: completes the task. It is the end of a route with no branch, which
  has nothing to land.

Agents work where the blocks before them put the task:

| Blocks before the agent | The agent works in | On |
|---|---|---|
| branch, worktree | a separate worktree | the task's branch (`worktree`) |
| branch | your checkout | the task's branch (`checkout`, the default) |
| none | your checkout | your current branch (`direct`) |

A project with no drawn pipeline runs the `checkout` choice. `foreman pipeline
use <checkout|worktree|direct> --project <name>` draws one of the three as the
project's pipeline, through the same file code as the pipeline editor. It refuses
when the project already has a drawing that is not one of the three, so a
hand-drawn pipeline is never lost. A worktree task can be served for a look:
`foreman preview <task>` runs the project's `scripts/preview.sh` in the task's
worktree, in the hc terminal `preview-<task>`, and prints that terminal's
address. A preview terminal that is still live is used again. The `preview`
action shows only on a row whose task has a worktree, in a project that keeps the
script. A task in your checkout needs no preview: your own dev server serves it.

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
   branch exists has passed the branch block; one whose worktree exists has
   passed the worktree block. So tasks in flight place correctly with no
   back-fill.
4. **Direct has no undo.** With no branch, a returned review leaves the author's
   commits on your branch, and the next author continues on top of them. Foreman
   cannot separate them from commits you made meanwhile.
. **A task lands on one branch, fixed when its branch is cut.** Every land a
   branch block reaches names the same `onto` (absent counts as one target), or
   validation names the blocks. An `onto` that names a `foreman/` branch is a
   problem too. The branch block records the target as the task branch's git
   upstream, and the pull request's base, the reviewer's base, the sweep's
   `merged` and `empty`, and the landing all read that upstream. A drawing edit
   applies to branches cut after it. A branch with no upstream lands on the
   branch your checkout has out, and a detached checkout measures against its
   `HEAD`. A direct route has no land and stays on your branch.
7. **A target that does not exist holds the project.** The held row names the
   target, at dispatch and at landing. A route in your checkout with no worktree
   (branch only) leaves the task's branch by checking its upstream out, so the
   checkout must have the target out to start one: otherwise the project is
   held, and the row names both branches. Foreman never moves your checkout to a
   branch you were not on.

## How the engine reads the blocks

- **branch and worktree are walked through, like gates.** Placement does not stop
  at them. `routeWorkspace` reads the shape from the task's route: none, branch,
  or branch and worktree. An agent's dispatch makes what is missing: the branch from the trunk tip, then the worktree. git is the record
  (rule 3): `Fleet.open` adopts a worktree git lists for the branch, and a branch
  that exists is not made again. So placement stays a function of the task's
  facts, and no tick makes a branch for a task that no gate has let start.
- **Occupancy of your checkout is read every tick.** For a task on a branch it
  is git's busy hold: a `foreman/*` branch out in the checkout. A direct task has
  no branch to read, so it occupies the checkout when its route is direct, an
  author run recorded a `base` there, and it is still in the pipeline. An author
  run with no `base` worked in a worktree or on a branch, and holds nothing. The
  planner starts each pass with these holds and adds the project when it plans a
  dispatch into the checkout. A dispatch into the checkout also needs a clean
  tree.
- **done and land are work blocks for validation.** Nothing reaches a done or a
  land without a review after the last source or author, and a gate stands
  before each. So a direct route cannot complete without review or a policy
  stop.
- **A landing applies the proved commit by the target's ref.** The proving
  ground resets to the target's tip. A target your checkout has out is
  fast-forwarded there, and your uncommitted edits hold only the landings that
  write the same paths. A target out nowhere is moved with
  `git update-ref refs/heads/<onto> <proved> <old tip>`, which fails when the
  tip moved, so your checkout is not touched and its edits hold nothing. A target
  that another worktree has out is fast-forwarded in that worktree. A tip that
  moved during the proof holds the landing, and a later tick proves it again.
- **Fast-forward lands only a commit that descends from the target's tip.** A target
  that moved after the branch was cut returns the task to the queue at the same
  rung, as a conflict does. Foreman never rebases: a rebase makes a commit the
  reviewer did not read.
- **Empty-branch detection reads the branch's own history.** After a fast-forward
  landing the tip is on the trunk's first-parent line, so "the tip is on the
  first-parent line" no longer means "nothing was committed".
- **A direct review reads the commits since the first author started.** Each
  direct author run records the checkout's HEAD as its `base` when it opens. The
  reviewer diffs from the first such base (rule 4), the task's tip is the
  checkout's HEAD while it occupies the checkout, and a tip past that base is the
  author's commit.

## Changes to what exists

- The standard pipeline is: source → branch → retry router → author → review →
  land (merge), in your checkout. The `worktree` choice adds a worktree block
  after the branch; the `direct` choice has neither block and ends at done.
- The policy `checkout` setting and its CLI command are removed. Its git code
  stays: leaving the task's branch before landing, merging the approved commit by
  id, and giving the checkout back.

## Rules this replaces

Each line names the old rule, where it stood, and what replaces it.

- "A `direct` mode … is not built" (AGENTS.md, Branch mode): direct is the route
  with no branch. Rule 4 accepts that a return cannot revert the task's commits.
- "`foreman policy checkout branch --project <name>` sets
  `projects.<name>.checkout`" and "the policy is read only to place a new
  workspace" (AGENTS.md, Branch mode; `src/policy.ts`): the route places the
  workspace, and the setting is gone.
- "A branch-mode project also needs an empty tree to start" (AGENTS.md;
  `isFree(directory, clean)`): every dispatch into the checkout needs a clean
  tree, read by `Repository.dirty`. `isFree` lost its `clean` flag.
- "`isFree` holds a checkout with a `foreman/*` branch out as `busy`" as the only
  one-task rule (AGENTS.md): the busy hold stays, and occupancy derived from the
  tasks covers direct, which has no branch to hold.
- "`--no-ff` is what makes the honest question cheap: every landing is a merge
  commit" (AGENTS.md, branches): a fast-forward landing exists, so `empty` also
  reads the branch's reflog.
- "every path from a source ends at a land block or a park" and "every path to a
  land passes a review agent" (`docs/pipeline-engine.md`): `done` is a third end,
  and the review and gate rules apply to it as to a land.
- "Every task ends by merging into the project's main checkout" and "landing is
  the only code path that moves the operator's branch" (AGENTS.md): both hold for
  a task with a branch. A direct task commits there from the start, by the
  operator's choice of route, and its `done` still waits for an approval.
- "A `branch` block makes `foreman/<id>` from the trunk tip" and "the branch a
  landing moves is whichever one `HEAD` names" (AGENTS.md, Workspace blocks and
  the operator's checkout): the branch is cut from the tip of `onto`, and the
  landing moves the branch the task branch's upstream names; with no upstream,
  `HEAD`'s branch, as before (rules 6 and 7).
- "`merged`: `HEAD` already contains the tip" and "`empty`: the tip is still on
  `rev-list --first-parent HEAD`" (AGENTS.md, the branches): both measure
  against the branch's upstream, else the checkout's branch.
- "the proving ground … reset to the checkout's current tip" and "landing's first
  question is whether `HEAD` already contains the branch" (AGENTS.md, the review
  gate): both read the target's tip, and a target out nowhere is moved by a
  compare-and-swap of its ref, which no dirty path holds.
- "landing is the only code path that moves the operator's branch for a task
  with a local landing" (AGENTS.md, the review gate): it moves the task's
  target, which need not be the operator's branch.

## Open question

A pipeline edit changes the route of tasks already in flight, because the shape
is read from the pipeline, not from git. A worktree project redrawn as direct
places its in-flight tasks at `done`, which completes them without landing their
branches. Validation refuses this shape for a new route ("work on this branch
never lands"), but not for a task whose branch already exists. One answer is that
`done` parks a task whose branch holds unmerged commits. This is the operator's
decision.
