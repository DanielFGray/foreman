# Agent exits

An exit is the name an agent says when it ends its run. The drawing wires each
exit to the block that comes next. The contract between an agent and foreman is
therefore in the drawing: the exits a block declares, and where each one leads.

The block table in `docs/pipeline-engine.md` ("How each work block ends a run")
gives what each block does for each ending.

## Terms

- **exit**: a name that ends a run, with a wire to the block that comes next.
  An agent names its exit, such as `approved`. A check's exits are `passed` and
  `failed`, and foreman names them.
- **exit id**: the exit's identity. A run stores the id, and placement looks the
  id up. A rename changes the name, not the id. A new exit gets a random id of
  the form `exit-<letters>`. An id has the form of a name (`[a-z-]+`), because
  the store reads an ending of that form as an exit.
- **process ending**: how a run stopped when no exit was named: `stopped` (the
  agent ended without naming one), `vanished`, `walled`, `released` or
  `canceled`. Foreman observes these. The operator does not declare them.
- **return**: an exit wired to `queue`. The task goes back to `open`, gives up
  its claim, and waits in queue order.
- **cycle**: a route that reaches a block it has already passed, such as review,
  then `returned`, then author, then review.
- **instructions**: the operator's text for one agent block. Foreman adds the
  generated Exits section to make the prompt.

## Blocks

An agent block has `role`, `model` and `slots`, and an `exits` list. It also has
`instructions` and `stopped`:

```jsonc
{ "kind": "agent", "id": "review", "role": "review", "model": "reviewers",
  "instructions": "review",          // a file under ~/.config/foreman/prompts/
  "exits": [
    { "id": "approved", "name": "approved", "to": "land-gate" },
    { "id": "returned", "name": "returned", "to": "author-gate", "fails": "author" },
    { "id": "needs-tests", "name": "needs-tests", "to": "tests-gate" }
  ],
  "stopped": "retry" }               // after a stop with no exit: retry or park
```

- `to` is a block id, or `queue` for a return.
- `fails` charges a rung when the exit is named. `author` charges the rung of
  the task's last author run. `self` charges the rung of this author block. A
  block with no rung, such as a reviewer or a check, may not name `self`. An
  exit with no `fails` charges no rung.
- `stopped: retry` keeps the task at the block. The block's model rule then
  picks the next seat: `ladder` counts an attempt and climbs when the level is
  spent, and `reviewers` passes over every reviewer that stopped. `stopped:
  park` parks the task instead.
- `instructions` names a file in the prompts directory. The name uses `a-z`,
  `0-9` and `-`.

**Check block.** It has the exits `passed` and `failed`, wired like an agent's
exits. The standard pipeline has no check block. Saved pipelines may wire
`failed` to `queue` with `fails: author`.

**Router.** A router reads the exits and counts of a task (rule 4).

**Land and done.** A land and a done have no exits. A conflict or a broken
verification is a process outcome of the land, not an exit.

**Correction rounds are not an exit.** A reviewer sends a correction to the live
author with `foreman correct` inside its review run. The author stays live while
it fixes, so the round does not move the task. The limit is `MAX_ROUNDS` in
`src/commands.ts`, which is two.

## Rules

1. **One exit per run.** An agent names exactly one exit, with `foreman exit
   <task> <name>`, or none. A second `foreman exit` in the same run takes the
   place of the first. A name the block does not declare is refused, and the refusal lists the
   declared names.
2. **An exit records the commit it was named on.** `foreman exit` reads the
   task's tip by its route (the branch tip, or the checkout's HEAD on a direct
   route). It writes the exit, the commit and any charged rung in one
   transaction. A land, commit or done block refuses when the tip differs from
   the commit of the exit that routed the task there. So any route into a land is
   safe, whatever its exits are called.
3. **A task is where its last exit leads.** Foreman stores no position. To place
   a task, it reads the task's last run that named an exit. It takes that exit's
   wire from the drawing as it is now, and walks on through routers, gates and
   workspace blocks to the next work block. A task with no such run, or one
   returned from the queue, starts at its source. The exit is evidence of what
   the agent said. The wire is the rule, so an edit to a wire moves the task.
   A set of passed blocks could not say where a task is, once a block can come
   round twice.
4. **Routers read exits and counts.** Three filter terms:
   - `exit:<name>`: the task's last exit was `<name>`;
   - `exits:<name>>=N`: the task has named `<name>` at least N times since it
     last left a source;
   - either of the two with a block, `exit:<block>/<name>` or
     `exits:<block>/<name>>=N`, counts only the exits named at that block. It
     tells apart two instances of one composite, whose inner exits share names
     (`composite-blocks.md`);
   - `attempts>=N`: the task has had N attempts at its level.

   An operator can send a third `returned` to park, or route `needs-tests` and
   `returned` differently out of one router.
5. **Every cycle can end.** Each lap of a cycle passes at least one of these:
   - a router with a route that leaves the cycle, where the route's filter is a
     count that grows on each lap, such as `exits:returned>=3` or `attempts>=2`;
   - an exit that has `fails`. Each lap charges a rung, and a task that every
     rung has failed parks.

   A smaller loop inside the cycle that passes neither can run forever, so
   validation names it. A gate stands before every work block in a cycle, so
   the policy can stop a loop at any time.
6. **The prompt's contract section comes from the drawing.** Foreman makes the
   prompt from four sections, in this order:
   - the task: id, title, project, and how to read it (`tasks show`);
   - the workspace: the directory and which git commands to avoid, from the
     workspace blocks;
   - the operator's instructions for the block;
   - the exits: one line per exit with its command and where it goes, then "Name
     exactly one exit. If you name none, the task <retries | parks>."

   The instructions may use `{{ task }}`, `{{ branch }}`, `{{ base }}` and
   `{{ worktree }}`, and each name in the block's `vars`
   (`composite-blocks.md`). Any other placeholder stops the pipeline. When the
   operator changes the drawing, the prompt changes with it.

## Recording an exit

- **Exit ids in the store.** An agent run ends with an exit id or a process
  ending. The store accepts any ending of the form of an exit name for an agent
  run. Only foreman knows the block, so foreman validates the name.
- **Charges.** An exit with `fails` writes a row to `charges` (see State).
- **Status.** `foreman exit` reopens the task only when the exit wires to
  `queue`. A wire to any other block leaves the status as `in_progress`. A task
  under review is `in_progress`, and its step is the block that placement puts
  it at.
- **Tips.** The exit holds only while the tip is still the commit it was named
  on. Any later commit voids it, and a correction round needs no special case:
  the reviewer names its exit after the round, on the new tip.
- **Commands.** `tasks verdict` names `approved`, `returned` or `already-done`
  for people who use `tasks` without foreman. Foreman's prompts name `foreman
  exit`.

## Placement

- An open agent run places the task at its block.
- Otherwise the last named exit is followed. An exit is **void** when the tip is
  not the commit it was named on, and either the exit was named at a check or
  its walk reaches a land or a done. An exit with no commit counts as moved. A
  void exit drops back to the exit before it.
- A run that named an exit is `ended` until settle closes it once its pane is
  idle. The next tick then places the task where the exit leads. So a landing
  comes one tick after the approval.
- When the last exit names an exit or a block that the drawing lacks, the task
  is a decision for the operator. It is published with the reason, and it
  holds its claim until the operator releases it or intervenes.

## Prompts

- The operator's prompts are the files in `prompts/` in foreman's config
  directory (`~/.config/foreman/prompts/`). A file there wins over the one
  foreman ships.
- An unknown placeholder, or a missing instructions file, stops the pipeline.
- The onboard and diagnose prompts are not agent blocks. They are whole files,
  with the same lookup and their own placeholders.
- The instructions foreman ships for agent blocks name no exit. Only the
  generated Exits section names exits, so a renamed exit cannot leave the
  instructions contradicting it. The operator's own instructions may name exits.
  Validation does not read them for exit names.
- No code reads an exit's name for its meaning.

**Claims.** An author exit may declare `empty: claim`. The claim says that the
trunk already does the task. An empty branch that the author hands over with
this exit goes to a reviewer. The reviewer gets the claim-checking instructions,
and the Exits section tells the author when to name the claim. The meaning comes
from the declared property, so a renamed claim keeps all three.

## The page

The Foreman pane's inspector lists an agent's or a check's exits from the block.
Each exit shows where it leads and the rung it charges.

The operator adds, renames and removes an agent's exits. The operator charges an
exit, and leads an exit to any block, an earlier one included, or to the queue.
Each action is a `PipelineChange` (`AddExit`, `RenameExit`, `RemoveExit`,
`ChargeExit`, `Rejoin`, `MakeComposite`, `Unpack`, `SetParam`, and `InsertOn`
for kind `composite`), sent through `foreman pipeline edit`. A definition is
edited through `foreman composite edit` with the same verbs on its blocks
(with `out:<exit id>` as a wire end) plus `AddParam`, `RemoveParam`,
`RenameCompositeExit` and the entry verbs `AddEntry`, `RemoveEntry`,
`RenameEntry` and `SetEntry` (`docs/composite-blocks.md`).

- A rename keeps the exit's id and its wire. Router filters and runs that name
  the former name are left unchanged. Validation names a filter that counts a
  name no block declares.
- A wire into a block that reaches the block it leaves is a **back wire**
  (`beltOf` in `src/pipeline-belt.ts`). It is laid out on a return lane past
  every block, and drawn dashed.
- The inspector edits the instructions with `foreman pipeline instructions`. It
  shows the prompt for a pretend task with `foreman pipeline prompt`, which
  renders through `Prompts.agent`, as `foreman prompt` does.

## Validation

A pipeline with any of these problems does not run:

- every exit is wired, its names are unique on the block, its ids are unique on
  the block, and its name matches `[a-z-]+`;
- `empty: claim` appears only on an author exit. An author block has at most
  one claim, and the claim does not return to the queue. Its route reaches a
  review before any other author block or a park. A check may stand between
  them;
- an agent block has at least one exit;
- every cycle can end (rule 5);
- a router filter that counts an exit names one that some block declares;
- every block is reachable from a source. From every block, some route reaches a
  land, a done or a park;
- a gate stands before every work block on every wire into it, cycles included;
- the workspace rules in `docs/workspace-blocks.md` hold. A route from a branch
  reaches a land or a park. No branch or worktree block stands after an agent or
  a check. A cycle therefore stays inside one workspace.

## State

Labels the operator sets, such as `size:N` and `research`, stay labels. The one
label foreman writes is `diagnosing:<intent>`, during an intervention. Foreman's
own state is in the runs table and two small tables in the same SQLite store.

| State | Stored as |
|---|---|
| where the task is | the last named exit (rule 3) |
| a rung failed the task | a `charges` row: an exit's `fails`, a stop that spent the level, or a floor the operator chose |
| attempts at a level | the author runs on any rung of the level that ended `stopped` or `vanished` after the newest charge on one of them |
| an account hit its limit on this task | the runs that ended `walled` since the task last landed |
| the task waits for the operator | a `parks` row: task, reason, time |
| the operator forgave a charge (`descend`) | the charge's `forgiven_at` is set; the row stays |

- A charge records the newest run on the task when it was written (`run`). So
  "after the charge" compares run ids, not clock times.
- `factsOf` is the one reader of these records. Its facts `failedBy`,
  `attempts`, `approved`, `underReview`, `exit` and `exits` come from the runs
  and the two tables, not from labels.
- The runs and the two tables are in foreman's database, keyed by task id. A
  tracker adapter therefore carries only task state. The database is the same
  file as the built-in task store.

## The standard pipeline, drawn with exits

- author: `done` goes to the review gate. `already-done` goes to the review gate
  and is the `empty: claim` exit. `stopped: retry`.
- review: `approved` goes to the land gate. `returned` goes to the climb gate,
  with `fails: author`. `stopped: retry`.

A returned review goes through the `climb` gate to the author. The author keeps
its claim, branch and worktree. The author's `ladder` model picks the next rung
above the charged author. This cycle is valid by rule 5, because `returned` has
`fails: author`. Queued retries pass through the retry router.
