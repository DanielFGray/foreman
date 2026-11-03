# Runs replace labels

Step 4 of `pipeline-engine.md` (tasks step 3b). Today foreman records what its
agents did as labels on the task (`by:<rung>`, `review-by:<rung>`, `approved`,
and others). A label has no time, no commit and no owner, so every transition
must remember which labels to remove. The comments on `Prog.release` and
`clearReview` describe the bugs this has caused. After this step, the task
store's `runs` table records each agent run and each check, and foreman derives these facts
from the runs.

## Scope

Labels that record what a run did become runs:

| Label | Becomes |
| --- | --- |
| `by:<rung>` | the rung of the task's latest author run |
| `review-by:<rung>` | the rung of the task's open review run |
| `review-failed-by:<rung>` | the review runs of this lap that ended with no verdict |
| `rounds:<n>` | the `rounds` column of the latest author run |
| `approved` | the lap's last verdict is an approval, and its commit is the branch tip |
| `satisfied` | the latest author run ended with the claim that the trunk already does the task |
| `passed:<node>` | the `node` of the runs that advanced the task |

Labels that stay:

- The ladder evidence: `failed-by:<rung>`, `attempt:<rung>:<n>` and
  `walled:<provider>`. All three answer one question: which rungs may author
  next. The operator corrects them by hand (`clearFailure`, and a pin, which
  marks every rung below it failed), and no run stands behind a correction. The
  runs table is also the model registry that `model_summary` reads, so a row
  made up for a correction would put false runs in the model statistics.
- Facts about the task, which a person sets: `needs-you`, `diagnosing:<intent>`,
  `research`, `onboard`, `size:<n>`, `bug`.

## The lap

A **lap** is the task's latest author run and every run after it. Each review
fact reads only the current lap:

- `reviewedBy`: the lap's open review run.
- `reviewFailedBy`: the lap's review runs that ended with no verdict.
- approved: the lap's last review run with a verdict approved, and its
  `commit` is the branch tip now.
- satisfied: the lap's author run ended `satisfied`.

A new author run starts a new lap, so everything the last reviews said goes out
of scope with no code that clears it. This replaces the clearing in `attribute`,
`release`, `clearReview`, `submit` and `review`.

## Schema

Migration `0001` changes in place, because it has not shipped. Two columns are
added to `runs`:

- `commit TEXT`: for an author run, the branch tip when it closed; for a review
  run, the branch tip when it opened (the commit the reviewer read).
- `ending TEXT`: how the run stopped. The agent may write it while the run is
  open (its verdict, below); settle writes it at close when the agent did not.
  NULL for a run nobody settled (imported, or launched by hand).

`ending` takes one of these values:

| Work | Written by the agent | Written by settle |
| --- | --- | --- |
| author | `satisfied` | `handed-off` (committed work for review), `unfinished`, `walled`, `vanished`, `released`, `canceled` |
| review | `approved`, `returned` | `no-verdict`, `walled`, `released` |

`outcome` stays the registry's four words (`committed`, `dropped`,
`handed-off`, `answered`). It says what became of the run's work, which is not
the same as how the run stopped: an author run stops `handed-off`, and its work
is known to have landed only later. So `outcomeOf` maps the ending to an
outcome when the run closes, and landing sets the lap's author run to
`committed` (or `answered` for research) in the transaction that completes the
task. It is written, not derived in the view, because runs launched by hand have
an outcome and no ending.

### The agent's verdict

An agent states how its run ended with one command:
`tasks verdict <task> approved|returned|satisfied`. It writes the ending on the
task's open run of the matching work (review for `approved` and `returned`,
author for `satisfied`), and makes the status change that goes with it in the
same transaction: `returned` reopens the task when its wire goes to the queue
(otherwise the task stays `in_progress` and placement reads the step from the
exit), `satisfied` leaves the task `in_progress` at the review step, and
`approved` leaves the status alone. A second verdict on the same run replaces
the first, so a reviewer that approves and then returns in one turn leaves
`returned`. There is no open run to write to after settle closes it, so a
verdict cannot change a closed run. The review and author prompts use this
command in place of `prog label … approved`, `prog open` and
`prog label … satisfied`.

`node` is the pipeline block the run ran at. Until the dispatcher places tasks
(step 5), foreman writes the standard pipeline's block for the role: `author`
or `review`.

## Writes

A run opens when foreman dispatches its agent and closes when settle sees it
end. The open and the close each share one transaction with the status change
that goes with them (`claim`, `submit`, `release` and the others), because both
are in the same store. A failed run write fails the transition. Today
`Runs.record` writes only at close and only warns when the write fails; that
changes, because runs are now the record foreman reads back.

- Dispatch an author: open an author run (rung, model, pool, node).
- Dispatch a reviewer: open a review run with `commit` = the branch tip now.
- A spawn that fails: delete the open run in the same transaction that
  releases the task. The agent never ran, so the run never happened.
- `correct` (a correction round): add one to the `rounds` of the lap's author
  run. That run has usually closed `handed-off`, because rounds go to an author
  while its work is in review.
- Settle: close the run, keeping the agent's ending if it wrote one, else
  writing its own; an author run that hands off records the tip as `commit`.
- Land: set the lap's author run outcome to `committed` or `answered`, in the
  transaction that completes the task.
- The operator clears a stale reviewer: close the open review run `no-verdict`.

Run reads and writes go in their own module in `packages/tasks`, not in
`store.ts`, which the tasks CLI work also changes.

## Reads

`Prog`'s task reads return each task with its runs, oldest first. The readers
(`authoredBy`, `reviewedBy`, `reviewFailedBy`, `isApproved`, `isSatisfied`) are
pure functions of the runs, and `isApproved` also takes the branch tip.
`factsOf` takes the runs and the tip.

## Behaviour that changes

- `submit` and `review` on a branch whose tip is unchanged keep an approval of
  that tip. Today they remove it. The commit rule says the approval is still
  true: nobody changed what the reviewer read.
- After a landing conflict, the task goes back to an author, whose new run
  starts a new lap. If the operator instead submits the same tip again, the
  approval of that tip holds and the task can land without a second review.
  `Held` already depends on this.
- Land checks the tip once more and merges the approved commit by its id
  (`pipeline-engine.md`, "A review passes one commit").

## Tests

The dispatcher tests use a fake `Prog` that models the labels a second time.
After this step the fake keeps run rows (open, close, add a round) and
nothing else. The readers it used to copy are the shared pure functions, tested
once against a scratch store. A fixture helper builds a task with its runs, so
each test changes in one place.

## Slices

Each slice removes its labels completely, with no dual writes, and commits after
the gate.

1. Schema, the runs module, and review state: `review-by`, `review-failed-by`,
   `approved` (with the commit rule) and `satisfied`.
2. Author attribution: `by` and `rounds`.
3. `passed` and `factsOf` from runs.
4. The cutover conversion and deleting the label constants.

## Cutover

Tasks in flight at merge time carry the old labels, and imported runs have no
commit or ending. A one-time conversion turns each in-flight task's labels into
runs: `by:<rung>` into an author run (open if the task is `in_progress`, else
closed `handed-off` with the branch tip as `commit`), `review-by:<rung>` into an
open review run, and `approved` into a closed `approved` review run with the
branch tip as `commit`. It then removes the converted labels. The conversion is
part of the cutover script and is tested on a fresh copy of `prog.db` before
it runs on the live store.

## Rules this changes in AGENTS.md

- "Approval is a durable `approved` label … any transition handing the task
  back … must clear it": replaced by the lap and the commit rule.
- "**Whatever ends a review clears `review-by:*`.**" and "`Prog.release`
  therefore clears it alongside `approved`": replaced. Settle closes the review
  run, and a closed run is not open.
- "`satisfied` is cleared wherever `approved` is": replaced. `satisfied` is the
  ending of an author run, so a new lap leaves it behind.
- "`review-failed-by:*` goes with the author": kept in meaning, by the lap.
- "`Held` … leaves the task in `reviewing` with its `approved` label": the task
  stays `in_progress` at its land step; the tip has not moved, so the review
  still passes.
