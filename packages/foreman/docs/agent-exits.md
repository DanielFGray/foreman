# Agent exits: the operator designs the contract

Status: rules 1 to 6 and the store's endings are built (ts-48b15f, ts-c3fdcf).
Rule 7, the State section and the page's exit editing are not. "What is built"
says where the build differs from the text below; where they differ, that
section is the rule.

## What is built

- **Schema and file.** Agent and check blocks have `exits`; agent blocks have
  `stopped`. The pipelines file is `version: 3`, and version 2 and 1 read with
  the standard exits wired as they were: `returned` and `failed` go to `queue`
  with `fails: author`. The standard pipeline wires a returned review to the
  `climb` gate with `fails: author`, keeping the claim, branch and worktree.
  It also keeps its retry router for queued retries. Agent blocks have
  `instructions`; blocks have no `rounds` yet.
- **Store.** An agent run ends with an exit name (`[a-z-]+`) or a process
  ending. A migration renamed the old endings: `handed-off` to `done`,
  `satisfied` to `already-done`, `no-verdict` and `unfinished` to `stopped`.
  An exit's `fails` writes a row in `charges` (State).
- **Placement.** An open agent run places the task at its block. Otherwise
  the last named exit is followed, and an exit is void when the tip is not the
  commit it was named on (an exit with no commit counts as moved) and either
  the exit was named at a check or its walk reaches a land or a done. A void
  exit drops back to the exit before it. A run that named an exit is `ended`
  until settle closes it once the pane is idle; the next tick places the task
  where the exit leads, so a landing comes one tick after the approval.
- **Status.** Six life statuses (ts-881e9e). `foreman exit` reopens the task
  only when the exit wires to `queue`; a wire to another block leaves the
  status as `in_progress` and placement reads the step from the exit. A task
  under review is `in_progress` at the review block. `role` stays (open
  question 3); open question 2 is answered.
- **Prompts.** Rule 6 is built (`src/prompt.ts`). The operator's directory
  is `prompts/` in foreman's config directory (`~/.config/foreman/prompts/`).
  An unknown placeholder or a missing instructions file stops the pipeline.
  The onboard and diagnose prompts are not agent blocks: they stay whole
  files, with the same lookup and their own placeholders.

Today the contract between an agent and foreman is fixed in two places: the
prompts ("run `tasks verdict <id> approved|returned`") and the store
(`REVIEW_ENDINGS`, `AUTHOR_ENDINGS` and `VERDICTS` in
`packages/tasks/src/runs.ts`). The block table in `docs/pipeline-engine.md`
("How each work block ends a run") fixes what each ending does. The graph has
forward wires only, so work that goes back must go through the queue. The
operator can redraw the blocks, but not what an agent may say, or where each
answer goes.

This design moves the contract into the drawing. An agent block lists the
**exits** the agent may name, and each exit is a wire to any block, an earlier
one included. The operator writes the rest of the prompt.

## Terms

- **exit**: a name that ends a run, with a wire to the block that comes next.
  An agent names its exit, such as `approved`. A check's exits are `passed` and
  `failed`, and foreman names them.
- **process ending**: how a run stopped when no exit was named: `stopped` (the
  agent ended without naming one), `vanished`, `walled`, `released` or
  `canceled`. Foreman observes these. The operator does not declare them.
- **return**: an exit wired to `queue`. The task goes back to `open`, gives up
  its claim, and waits in priority order again.
- **cycle**: a route that reaches a block it has already passed, such as
  review → `returned` → author → review.
- **instructions**: the operator's text for one agent block. Foreman adds the
  generated sections (rule 6) to it to make the prompt.

## Blocks

**Agent block.** It keeps `role`, `model` and `slots`, and replaces `next` with
`exits`:

```jsonc
{ "kind": "agent", "id": "review", "role": "review", "model": "above",
  "instructions": "review",          // a file under ~/.config/foreman/prompts/
  "rounds": 2,                       // correction rounds this reviewer may send
  "exits": [
    { "name": "approved", "to": "land-gate" },
    { "name": "returned", "to": "author-gate", "fails": "author" },
    { "name": "needs-tests", "to": "tests-gate" }
  ],
  "stopped": "retry" }               // after a stop with no exit: retry or park
```

- `to` is a block id, or `queue` for a return.
- `fails` charges a rung when the exit is named. `author` charges the rung of
  the task's last author run (today's `climb`), and `self` charges this block's
  rung. When it is absent, the exit charges no rung.
- `stopped: retry` keeps the task at the block. The block's model rule then
  picks the next rung, as today: `ladder` counts an attempt and climbs when the
  rung is spent, and `above` reads above every reviewer that stopped.
  `stopped: park` parks the task.

**Check block.** It has the exits `passed` and `failed`, wired like an agent's.
The standard pipeline has no check block. Saved pipelines keep `failed` wired
to `queue` with `fails: author`.

**Router.** Routes may lead into or out of a cycle. Routers read two new terms
(rule 4).

**Land and done.** These stay as they are. A conflict or broken verification is
a process outcome, not an exit.

## Rules

1. **One exit per run.** An agent names exactly one exit, with
   `foreman exit <task> <name>`, or none. A second `foreman exit` in the same run
   replaces the first, as a second verdict does today. A name the block does not
   declare is refused, and the refusal lists the declared names.
2. **An exit records the commit it was named on.** `foreman exit` reads the
   task's tip by its route (the branch tip, or the checkout's HEAD on a direct
   route) and writes the exit and the commit to the run, and any charged rung
   to `charges`, in one transaction. A land, commit or done block refuses when the tip differs
   from the commit of the exit that routed the task there. This replaces the
   idea of an approval: any route into a land is safe, whatever its exits are
   called. A correction round needs no special case, because the reviewer names
   its exit after the round, on the corrected tip.
3. **A task is where its last exit leads.** Foreman stores no position. To place
   a task, it reads the task's last run that named an exit, takes that exit's
   wire, and walks on through routers, gates and workspace blocks to the next
   work block, as `place` walks today. A task with no such run, or one that came
   back from the queue, starts at its source. When the last exit names a block
   or exit the operator deleted, the task starts at its source again. The
   exit is evidence of what the agent said, not a pointer to what runs next:
   its wire is read from the drawing as it is now, so an edit to the wire moves
   the task, as "A task records what failed it, never what runs next"
   (CLAUDE.md) asks. This replaces the "passed" set (`passedNodes` in `src/lap.ts`), which cannot say
   where a task is once a block can come round twice.
4. **Routers read exits and counts.** Two new filter terms:
   - `exit:<name>`: the task's last exit was `<name>`;
   - `exits:<name>>=N`: the task has named `<name>` at least N times since it
     last left a source.

   With these, an operator can send a third `returned` to park, or route
   `needs-tests` and `returned` differently out of one router.
5. **Every cycle can end.** A cycle is valid when at least one of these is true:
   - it passes a router with a route that leaves the cycle, and that route's
     filter is a count that grows on each lap, such as `exits:returned>=3` or
     `attempts>=2`;
   - one of its exits has `fails`. Each lap charges a rung, and a task that
     every rung has failed parks, as today.

   Validation names each cycle that can loop forever. A gate stands before every
   work block in a cycle, as on any route, so the policy can stop a loop at any
   time.
6. **The prompt's contract section comes from the drawing.** Foreman makes the
   prompt from four sections, in this order:
   - the task: id, title, project, and how to read it (`tasks show`);
   - the workspace: the directory and which git commands to avoid, from the
     workspace blocks;
   - the operator's instructions for the block;
   - the exits: one line per exit with its command and where it goes, then "Name
     exactly one exit. If you name none, the task <retries | parks>."

   When the operator changes the drawing, the prompt changes with it. The
   instructions may use `{{ task }}`, `{{ branch }}`, `{{ base }}` and
   `{{ worktree }}`, and nothing else. Validation names an unknown placeholder.
7. **Correction rounds stay inside the review run.** A round does not move the
   task, so it is not an exit. The reviewer stays live while the author fixes,
   which a cycle cannot do. The review block's `rounds` setting replaces the
   fixed `MAX_ROUNDS` in `src/commands.ts`, and `rounds: 0` takes
   `foreman correct` out of the reviewer's prompt.

## State

Labels the operator sets, such as `size:N` and `research`, stay labels.
Foreman's own state is in the runs table and two small tables in the same
SQLite store (built on ts-4e763a). The one label foreman still writes is
`diagnosing:<intent>`, during an intervention.

| State | Before | Now |
|---|---|---|
| where the task is | the "passed" set, from run endings in the lap | the last named exit (rule 3) |
| a rung failed the task | the label `failed-by:<rung>` | a `charges` row that is not forgiven: an exit's `fails`, a stop that spent the level, or a floor the operator chose |
| attempts at a level | the label `attempt:<rung>:<n>`, per rung | the author runs on any rung of the level that ended `stopped` or `vanished` after the newest charge on one of them |
| an account hit its limit on this task | the label `walled:<provider>` | the runs that ended `walled` after the task last landed |
| the task waits for the operator | the label `needs-you` | a `parks` row: task, reason, time; removed by `descend` |
| the operator forgave a rung (`descend`) | the `failed-by:` label removed | the rung's charges get `forgiven_at` |

A charge records the newest run on the task when it was written (`run`), so
"after the charge" compares run ids, not clock times.

- **Facts.** `failedBy`, `attempts`, `approved` and `underReview` in `Facts`
  are read from the runs and the two tables, not from labels. `exit` and
  `exits` are added.
- **One reader.** `factsOf` stays the only function that reads these records,
  so the rest of foreman sees facts, not rows.
- **Where it lives.** The runs and the two tables are in foreman's database,
  keyed by task id, so a tracker adapter carries only task state (decision on
  ts-4e763a, 2026-11-01). Today that database is the same file as the built-in
  task store. AGENTS.md's durable-state rule names these records.
- **Migration.** The store migration `0007_charges_and_parks` makes the two
  tables. `foreman cutover runs` turns each `failed-by:` label of an
  unfinished task into a charge, `needs-you` into a park, and each
  `attempt:<rung>:<n>` into `n` stopped author runs (their `evidence` names the
  label), then removes the labels. A `walled:` label is removed with no record.

## Validation

These are problems: a pipeline with any of them does not run.

- Every exit is wired, and its names are unique on the block and match
  `[a-z-]+`.
- An agent block has at least one exit.
- Every cycle can end (rule 5).
- Every block is reachable from a source, and from every block some route
  reaches a land, a done or a park. This replaces "no cycle" and "every path
  ends at a land, a done or a park".
- A gate stands before every work block on every wire into it, cycles included.
- The workspace rules in `docs/workspace-blocks.md` still apply: a route from a
  branch reaches a land or a park, and no branch or worktree block stands after
  an agent or a check. A cycle therefore stays inside one workspace.

This is a hint: the editor shows it, but the pipeline runs.

- "This exit is never read": a return named `<name>` that no router reads with
  `exit:` or `exits:`.

## The standard pipeline, drawn with exits

- author: `done` → review gate; `already-done` → review gate (the old
  `satisfied`); `stopped: retry`.
- review: `approved` → land gate; `returned` → climb gate, `fails: author`;
  `stopped: retry`.

A returned review goes through the `climb` gate to the author, keeping its
claim, branch and worktree. The author's `ladder` model picks the next rung
above the charged author. This cycle is valid by rule 5 because `returned`
has `fails: author`. Queued retries still pass through the retry router.
The standard pipeline has no check block. The store's author ending
`handed-off` became the exit `done`.

## Changes to what exists

- **The pipelines file goes to `version: 3`.** On read, each agent and check
  block gets the standard exits for its role, and each agent block gets the
  instructions for its role. Saved pipelines wire `returned` and `failed` to
  `queue` with `fails: author`, so they behave as today. Only the standard
  pipeline wires `returned` back to the author through `climb`. The read
  writes nothing, as with version 2.
- **Prompts.** The files under `prompts/` become the default instructions,
  without the contract text and the `{% %}` logic. That logic moves into the
  generated sections. An operator's files live in `~/.config/foreman/prompts/`
  and win over the defaults. The `FOREMAN_PROMPTS` variable is removed.
- **The store.** An agent run's `ending` holds an exit name or a process
  ending. The store accepts any exit name for an agent run, because only
  foreman knows the block, and foreman validates it. The rung an exit charges is a
  row in `charges` (State). `VERDICTS` is removed. `tasks verdict`
  stays for people who use `tasks` without foreman; `tasks review` is removed
  (ts-881e9e). Foreman's prompts stop naming them.
- **Laps.** A lap today starts at an author run. Rule 3 and the State table read
  the last exit and per-rung counts instead, so `lapOf` remains only where a
  rule needs "since the last author run", such as `rounds`.
- **`corrected` and `rereadReview` are removed.** They move a review run's
  commit after a correction round. Rule 2 records the commit when the exit is
  named, so nothing needs to move.
- **The page.** The inspector lists an agent block's exits, which the operator
  adds, renames and wires as router routes are edited today. A wire may point
  back up the belt. The inspector also edits the instructions file and shows a
  preview of the full prompt from `foreman prompt <role> <id>`.

## Rules this replaces

Each line names the old rule, where it stands, and what replaces it.

- "The graph has forward wires only. Work that goes back returns to the queue
  with the evidence it earned" (`src/pipeline.ts`, header): rules 3 and 5. Work
  that goes back may follow a wire. A return to the queue is still an exit
  target.
- "No cycle" and "every path ends at a land, a done or a park"
  (`docs/pipeline-engine.md`, Validation): the reachability rule and rule 5.
- "A review passes one commit … the run holds the branch tip its reviewer
  reads: the tip when it opened, moved … when a correction round ends"
  (AGENTS.md): rule 2. The commit is the tip when the exit is named.
- "Two correction rounds, counted" and `MAX_ROUNDS = 2` (AGENTS.md;
  `src/commands.ts`): rule 7.
- "A reviewer that stops without a verdict is the reviewer's failure"
  (AGENTS.md): it stays as `stopped: retry` on a block whose model is `above`.
  `stopped: park` is new.
- "How each work block ends a run" (`docs/pipeline-engine.md`): an agent's or a
  check's advance and return are its exits, read from the drawing. Land and done
  keep their rows.
- "An agent reports its ending with `tasks verdict`"
  (`docs/pipeline-engine.md`; `prompts/*.md`): agents run `foreman exit`.
- "Review state is the current lap's runs" (AGENTS.md): placement reads the last
  exit (rule 3), and counts read the runs per rung (State).
- The rows "Which rung comes next?", "How many tries has this rung had?" and
  "Is this one waiting on a person?" of the table in CLAUDE.md, and the
  sections that read labels ("Every label is `<kind>:<value>`", "`needs-you`
  is the one durable way into the operator's column", `descend` unwriting a
  `failed-by:*` label): the State section. The labels `failed-by:`,
  `attempt:`, `walled:` and `needs-you` are gone (done on ts-4e763a).
- The epic's first description said "correction rounds become an exit wired
  back to the author". Rule 7 replaces it: a round keeps the reviewer live.

## Open questions

1. **Land without review.** Validation refuses a route that reaches a land or a
   done with no agent after its last author ("Every path to a land or a done
   passes a review agent", `docs/pipeline-engine.md`). Rule 2 keeps a landing
   safe from commits made after the exit, but not from unreviewed work.
   CLAUDE.md says "Nothing skips review" for the same reason. Should
   this become a hint, so that an operator can draw a pipeline with no review?
2. **The `reviewing` status.** Answered by ts-881e9e: it is gone. A task under
   review is `in_progress`, and its step is the block placement puts it at.
3. **Roles.** `role` now selects only the model rule (`ladder` or `above`) and
   whether `rounds` applies. It could become those two settings, so that a user
   can draw agents that are neither author nor reviewer.
4. **Commit block (ts-b226dd).** With uncommitted work, the commit in rule 2 is
   a snapshot commit. That task settles how a snapshot is made and kept.
