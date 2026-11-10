# Command blocks

A **command block** runs a local command as a step in a project's pipeline. It
replaces today's check block. The operator draws one block kind, `command`, and
picks a **plugin**: a named kind defined in the plugins file. A plugin is how a
command becomes a reusable block with declared exits, parameters, requirements
and a system boundary. Nothing is fetched from the network.

Four jobs share that one kind:

- **Change the work**: commit on the task's branch.
- **Choose a route**: name one of several exits after reading the task.
- **Talk to the outside**: chat, an issue tracker, an HTTP API, or any other
  emission foreman cannot take back.
- **Gate with task context**: run a command that sees the task as JSON, then
  name `passed` or `failed` (today's check, with context).

Recovery after a crash follows the system boundary in Shi, Zhang, Cui, "A
Programming Paradigm for Spatiotemporal Composability" (arXiv 2608.25512,
section 6.1), as amux does.

## Operator decisions (2026-11-07)

Recorded by the orchestrator from the operator's answers. Sections 1 to 8 rely
on them.

- **No policy step.** Drawing a command block in a pipeline is the permission,
  for inside and outside plugins alike. A command block has no gate before it.
- **No fleet slot.** A command block takes no slot of the fleet's `slots`, as
  checks do today. A plugin may cap its own concurrent runs with `slots`.
- **Every command has a timeout.** `timeoutMinutes` defaults to 10.

## Operator decisions (2026-11-09)

Recorded by the orchestrator from the operator's answers. Sections 9 and 10
rely on them.

- **A gate runs the target's copy.** Verify and every check-shaped block run the
  command as it stands on the branch the task lands on, not the task's own copy
  (section 10).
- **Blocks come from the project's own tooling.** The operator's words: "ideally
  we integrate with known project tooling, if we find a package.json we can list
  .scripts, there's probably similar we can do for other platforms." The
  operator was not sure of the split between that and the plugins file. Section
  9 is the orchestrator's proposal for it, still to be confirmed.

## Terms

- **plugin**: a named command-block kind in the plugins file. It names a
  command, exits, parameters, requirements, a boundary, and optional
  compensation.
- **command block**: a pipeline node of kind `command`. It names a plugin
  (`of`), wires each exit, and fills parameters (`set`), as a composite
  instance does.
- **invocation key**: the triple `(task, block, tip)` foreman records before an
  outside command runs, and passes to that command. It is how a second run of
  the same work is recognised.
- **boundary**: where the plugin's effects fall. `inside` means the task's own
  branch and worktree, which foreman can restore. `outside` means an emission
  foreman cannot take back.
- **workspace mode**: where the task works, per the pipeline: `worktree` (a
  directory foreman made for the task), `checkout` (the operator's checkout on
  the task's branch), or `direct` (the operator's checkout on the operator's own
  branch, no branch). `docs/workspace-blocks.md` defines them.
- **requirement**: a coeffect the plugin declares (an environment variable, a
  binary on `PATH`, a login). A block whose requirements are unmet does not
  run.
- **run snapshot**: the plugin entry as it was when a run started, stored in
  the run row in foreman's own records.

## 1. One block kind

The pipeline node kind is `command`. A check is a command block of the built-in
plugin `check`, with exits `passed` and `failed`.

The **kind `check` is deleted**. Foreman does not read a `kind: "check"` node,
does not convert one on load or on save, and has no alias for it. The
operator's pipelines and drafts files hold no check node today, so there is
nothing to convert. The standard pipelines that `foreman pipeline use` draws
write `command` with `of: "check"` directly.

Why no conversion: foreman has no compatibility path for a shape nobody
deployed, and a converter would be a second path that must stay in step with
the first. A drawing that still holds `kind: "check"` gets one problem row,
which names the replacement, so the operator edits it by hand.

The **router stays**. A router is instant and reads facts (counts, failures,
labels). A command that chooses a route is for a choice that needs a process:
external state, a binary, or logic a filter cannot express. Counts and filters
stay on the router; judgment that needs a command is a command block.

## 2. Input and output

Foreman runs the plugin's command with the task as JSON on standard input:

```jsonc
{
  "id": "ts-…",
  "project": "foreman",
  "branch": "foreman/ts-…",
  "tip": "<commit>",
  "base": "<commit>",
  "description": "…",
  "parameters": { "command": "./scripts/lint.sh" },
  "key": "<invocation key>"
}
```

`key` is present only for an `outside` plugin. The Schema lives in foreman
(`CommandInput`); plugins do not define it.

Every plugin's exit is one of two declared ways, chosen by its entry:

- **stdout** (the default): the first line of standard output is an exit id the
  block declares. Process status 0 means that exit stands. A non-zero status is a
  process failure, not an exit name. A line that is not a declared exit is a
  process failure too.
- **`exitFromStatus`**: the plugin's exits are exactly `passed` and `failed`.
  Status 0 names `passed`; any other status names `failed`. Standard output is
  not read.

Both are general options on the plugin entry. The `check` plugin is an ordinary
entry that sets `exitFromStatus` and `compareBase`. No plugin has a protocol of
its own, and no block has a second channel.

## 3. The plugins file

The plugins file sits beside the policy and pipelines files
(`$FOREMAN_PLUGINS`, else `plugins.json` under the config directory). It is one
of the durable files that hold operator intention. AGENTS.md "The world holds
the work" lists it with the policy, pipelines, drafts and instructions files,
and names the composites object inside the pipelines and drafts files (that
object was already durable and missing from the list).

```jsonc
{
  "plugins": {
    "check": {
      "boundary": "inside",
      "ground": "proving",
      "exitFromStatus": true,
      "compareBase": true,
      "exits": [
        { "id": "passed", "name": "passed" },
        { "id": "failed", "name": "failed" }
      ],
      "params": [{ "name": "command" }],
      "requirements": [],
      "timeoutMinutes": 30
    },
    "notify-landed": {
      "command": ["~/.config/foreman/plugins/notify-landed.sh"],
      "boundary": "outside",
      "ground": "none",
      "idempotent": true,
      "exits": [{ "id": "sent", "name": "sent" }],
      "params": [],
      "requirements": [
        { "kind": "env", "name": "SLACK_BOT_TOKEN" },
        { "kind": "bin", "name": "curl" }
      ],
      "compensate": ["~/.config/foreman/plugins/notify-landed-undo.sh"],
      "timeoutMinutes": 2
    }
  }
}
```

- **`command`**: the argv foreman runs, as an array. No shell unless the
  operator's script starts one. When the entry omits `command`, the block's
  `command` parameter is the argv, as a `check` block's is. A plugin with neither
  is refused.
- **`boundary`**: `inside` or `outside`.
- **`ground`**: where the process's working directory is. `worktree` is the
  task's worktree or checkout. `proving` is the project's proving ground at the
  tip, a disposable tree (section 4 relies on this). `none` is foreman's own
  directory (no project tree).
- **`exitFromStatus`**: see section 2.
- **`compareBase`**: general. When true, after the exit is decided foreman
  compares the tip with the base as it does for checks today, and a run whose
  tip moved while the command ran is not recorded. `check` sets it. Any plugin
  may.
- **`idempotent`**: for `outside` only. When true, the invocation key makes a
  second run safe and foreman retries a started-with-no-end run with the same
  key. When false, that case is a decision for the operator.
- **`compensate`**: optional undo argv. It takes the same input Schema, plus the
  exit the forward run named.
- **`requirements`**: `env` or `bin`. A login probe is not a kind: foreman has
  none of its own, and a plugin that needs a login names an `env` or `bin`
  requirement that the operator's environment satisfies (for example `gh` on
  `PATH` with its token in `GH_TOKEN`). Secrets are environment values only. The
  pipelines file and the plugins file never hold them.
- **`timeoutMinutes`**: wall clock from start. Default 10. A timeout is a
  process failure for recovery.
- **`slots`**: optional cap on how many of this plugin's runs run at once. It
  is not a fleet slot (section 7).

The palette offers each plugin as a block kind. `problemsOf` checks that a
pipeline's `of` names a plugin, that every wired exit id is declared, that each
required parameter is set, that a plugin with no `command` has a `command`
parameter, and that an `outside` plugin with no `idempotent` field is refused
(the operator must say whether a retry is safe). It refuses a `kind: "check"`
node with the replacement named.

## 4. The system boundary

Each plugin declares where its effects fall. The boundary and the workspace mode
together decide recovery: whether foreman can restore the state before the run.

### Inside

Effects are commits on the task's own branch and uncommitted edits in its tree.
Foreman records the tip before the run. What recovery may do depends on the
workspace mode, because only a worktree belongs to foreman alone:

- **`worktree`**: foreman owns the directory and the branch. After a process
  failure or a crash (a started run with no end), it resets the branch and the
  worktree to the recorded tip and runs again.
- **`checkout` and `direct`**: the tree is the operator's. A reset would drop
  edits the operator made during the run, and in `direct` it would also drop
  the operator's own commits (`docs/workspace-blocks.md`, rule 4). So foreman
  never resets there. After a failure or crash it retries only when the tree is
  clean and HEAD is still the recorded tip, which means the run left nothing
  behind. Otherwise the task goes to the operator as a decision (attention),
  with `release` and `intervene`, and the tree is not touched.
- **`ground: proving`** (any mode): the command runs in the disposable proving
  ground, not in the task's tree, so there is nothing to reset. A started run
  with no end is run again.

A plugin with `boundary: inside` and no commits, such as `check`, is therefore
safe in every mode: it runs in the proving ground.

### Outside

An emission foreman cannot take back. Acquisition before emission: foreman
records the run as `started`, with the invocation key, in its own records
**before** the command runs, and passes `key` on standard input. A started run
with no end is the uncertain case. The plugin's `idempotent` flag says which
side it is on:

- `true`: a second run with the same key is safe (the command itself treats the
  key as idempotent). Foreman runs it again with that key.
- `false`: the outcome may already have happened. The task goes to the operator
  as a decision (attention), with `release` and `intervene`. Nothing retries it.

### Withholding

`problemsOf` **warns** when an `outside` block stands on a route where a later
block can still undo the state the outside report describes. The usual case is
a message or issue posted before a land: the land can still fail, and the
message already left. The warning names the outside block and the later undoing
block. It does not refuse the drawing. Compensation covers abandon; withholding
is the operator's choice at draw time, surfaced rather than silent.

### Compensation

When the task's work is abandoned (`cancel`, `kill`, or a reset that drops the
branch), foreman runs each finished outside run's compensate command in reverse
order of those runs. It uses the compensate argv in that run's snapshot (section
6), the same invocation key, and the exit that run named. A compensate process
failure is logged and the next compensate still runs; the abandon does not wait
on a perfect undo. Inside runs need no compensate: the tip reset (worktree) or
the operator's decision (checkout, direct) is their undo. Unfinished
(started-with-no-end) outside runs are not compensated; they follow the
uncertain-case rule above first.

## 5. Requirements as coeffects

A plugin declares what it needs. Before a command block runs, foreman checks
each requirement. A miss holds the task at the block and publishes an attention
row that names the block and what is missing. The row clears when the
requirement appears; the next tick runs the block. No park is written: an
absent binary is a fact about the machine that can clear itself, like a spent
quota.

Secrets come from the environment the dispatcher already runs in. A requirement
of kind `env` names the variable; its value never enters the plugins file, the
pipelines file, or a run row.

## 6. Binding and the run snapshot

A run stores a **snapshot** of the plugin entry it started with, in foreman's
own records, not a hash. Settle, recovery and compensation read the command,
exits, boundary and compensate argv from that snapshot. So an edit to the
plugins file, or removing the plugin, during a run changes nothing about that
run, and no recovery path needs the operator's file to still hold the old
definition.

- A compensate argv whose script was deleted fails as a process failure, is
  logged, and the next compensate runs (section 4).
- New runs read the file as it is now.
- The snapshot holds no secret: requirements name variables, and values are
  never stored (section 5).

A hash was rejected because it identifies a definition without giving recovery
the definition to run. A snapshot costs one JSON value per run.

## 7. Where commands run

Landings and checks today share the dispatcher's one fiber and one proving
ground per project. A slow command there stalls every project.

- **Fiber.** Each command block runs on its own fiber, started from the tick.
  The tick fiber only plans and waits for landings that still need the proving
  ground's exclusive use. A command never holds the tick fiber for the duration
  of its process.
- **Proving ground.** A plugin with `ground: proving` takes the project's
  proving-ground lock, shared with land. Land and proving commands on one
  project stay serialised. Other projects and other grounds run in parallel.
- **Fleet slots.** A command block takes no fleet slot (operator decision,
  2026-11-07). A plugin's `slots` caps that plugin's concurrent runs, so an
  unbounded pile of one command is still prevented.
- **Timeout.** `timeoutMinutes` on the plugin (default 10). On timeout foreman
  kills the process and treats it as a process failure for recovery.

## 8. Tests

The gate covers, as unit tests over the runner with a fake command:

- Inside, `worktree`: a crash between "started" and the end resets the branch
  and worktree to the recorded tip and runs again; the second run's commits are
  the ones that remain.
- Inside, `checkout` and `direct`: a crash with a clean tree at the recorded
  tip runs again. A crash after the run committed, or with a dirty tree, becomes
  a decision, and the test asserts that the tree and HEAD are unchanged.
- Inside, `ground: proving`: a crash runs again with no reset of the task's
  tree.
- The run snapshot: editing or removing the plugin during a run, then a crash,
  recovers with the command and compensate argv from the snapshot.
- For an `outside` plugin with `idempotent: true`: a started-with-no-end run is
  retried with the same invocation key, and the command receives that key both
  times.
- For an `outside` plugin with `idempotent: false`: a started-with-no-end run
  becomes a decision and is not retried.
- Compensation runs in reverse order of finished outside runs when a task is
  canceled, and a failing compensate does not skip the rest.
- An unmet requirement publishes the attention row and runs no command; when
  the requirement appears, the next tick runs it.
- A plugin's `slots` caps its concurrent runs, and a command run takes no fleet
  slot.

No test starts `foreman serve`.

## 9. Commands the project already names (proposal)

Not decided. The operator asked for blocks from the project's own tooling and
was not sure how that combines with the plugins file. This is the
orchestrator's proposal.

A **command source** reads one kind of project tooling. It has three jobs: say
whether a tree has that tooling, list the names it holds, and resolve one name
to the command text at a given commit. The first two sources:

- **`scripts/`**: each executable file under `scripts/` is a name. Its command
  is the file. `verify`, `worktree-setup` and `preview` keep their roles.
- **package.json `scripts`**: each key is a name. Its command is the value. The
  package manager comes from the lockfile beside it: `bun.lock` or `bun.lockb`
  for bun, `pnpm-lock.yaml` for pnpm, `yarn.lock` for yarn,
  `package-lock.json` for npm.

Every other kind of tooling (make, just, cargo, pyproject, deno, composer) is a
later source. Each is checked against the tool's own documentation before it is
built.

A discovered name is a ready-made block of the built-in `check` plugin, with its
`command` parameter filled: `inside`, `ground: proving`, judged by exit status.
The palette offers it. Foreman never draws one by itself, because a `dev` or
`watch` script runs until its timeout.

Shapes that carry trust or recovery stay in the plugins file: `outside`,
`idempotent`, `compensate` and `requirements`. A plugin there may run a
discovered command. There is no checked-in manifest of block kinds, although the
operator's "all of the above" included one. A manifest lives on the branch
under review, so a patch could declare its own outside block `idempotent` or
drop its requirements. Discovery reads only names and command text, which
section 10 already takes from the target.

Under section 10, a discovered command runs as the target's text. `bun run test`
in the merged tree reads the branch's package.json, so a source resolves the
text at the target's tip and foreman runs that text in the merged tree. The
slice that builds the package.json source checks how each package manager runs
a literal command with the project's local binaries on `PATH`, and what it
loses (pre and post scripts, the manager's environment variables).

## 10. Which copy gates a patch

A **gate** is verify at landing, and every command block of the `check` plugin.
A gate runs the command as it stands at the tip of the task's target (the
branch's upstream, as for landing), never the task's own copy. For a script,
foreman reads the file from the target's tip, writes it outside the tree, and
runs it with the merged tree as its working directory. For a discovered
command, the source resolves the text at the target's tip (section 9).

- A patch that changes a gate is tested by the gate it replaces. The new gate
  takes effect after it lands. The review prompt names each gate file the diff
  changes, so the reviewer reads the change.
- `worktree-setup` is not a gate. It runs the tree's own copy, because a branch
  that adds a dependency needs its own install.
- The baseline is unchanged: it runs the target's gate on the target's tree.
- A target with no gate has no landing gate, as today. A branch that adds the
  first gate, or renames the one there, lands without one.

**Limit.** The target's copy protects the gate's entry point only. The test
files, the helpers and scripts the gate calls, the package configuration, and
what `worktree-setup` installs all come from the branch. It closes the cheapest
bypass, a patch that changes its gate to pass. The reviewer stays the guard
for weakened tests, as AGENTS.md "The review gate" says.

**Open.** A target gate can fail because the branch validly changed something
the gate calls, such as a renamed helper. Then the merged tree is red, the
baseline is green, and foreman charges the branch. Whether that case is a charge
or a decision for the operator is a question task under this epic.

## What it replaces, and conflicts

Each rule below is changed by this record. The record wins in each case. Where
the losing text stands is the file named in the "Where it stands" column; each
of those files must be edited in the build slice named in the last column.

| Rule | Where it stands | Change | Built by |
| --- | --- | --- | --- |
| Check is its own block kind with `command` and exits `passed` / `failed` | `src/pipeline.ts` `CheckNode`; `docs/pipeline-engine.md` Blocks; `docs/agent-exits.md` Check block | Kind `check` is deleted, with no conversion. `command` with `of: "check"` replaces it. The global rule "No backwards compatibility with unshipped code" is the basis; the operator's files hold no check node. | ts-44824b |
| A check gets no task context | epic `ep-3ca01a`; `runCheck` in `src/dispatcher.ts` | Standard input carries the task JSON for every command plugin. | ts-ed85e7 |
| A check's command is judged only by exit status | `CheckNode` doc comment; `repository.check` | Judged by the plugin entry: `exitFromStatus` (status) or stdout. `check` sets `exitFromStatus`. | ts-ed85e7 |
| A check takes no slot | `docs/pipeline-engine.md` Blocks table; settle path in `src/dispatcher.ts` | Unchanged for command blocks: no fleet slot. A plugin may cap its own runs with `slots`. | ts-ed85e7 |
| Every agent, check, land and done has a gate on each path into it; a check's gate names an existing step | `docs/pipeline-engine.md` lines on policy steps ("The policy has no step of its own for a check"; "So does every check") | No policy step and no gate for a command block. Drawing it is the permission, for inside and outside plugins alike (operator decision, 2026-11-07). The validation that "every path to a check passes an author first" stays for `command` with `of: "check"`. | ts-44824b |
| Landings and checks are serialised by the dispatcher's one fiber over one proving ground per project | `AGENTS.md` Front ends | Landings and `ground: proving` commands share the proving-ground lock. Each command runs on its own fiber. The tick fiber does not wait out a non-proving command. | ts-ed85e7 |
| Inside recovery is by tip reset | this record, section 4 (earlier draft) | Reset only in `worktree`. `checkout` and `direct` never reset; they retry only at a clean recorded tip, else decide. | ts-9aecc2 |
| The plugin's definition is bound by hash | this record, section 6 (earlier draft) | A run stores a snapshot of the plugin entry. | ts-ed85e7 |
| Login probe as a requirement kind | this record, section 3 (earlier draft) | Removed. Requirements are `env` and `bin`. | ts-604c78 |
| The durable intention files are the policy, pipelines, drafts and instructions files | `AGENTS.md` "The world holds the work" | Those four, plus the plugins file. The same paragraph names the composites object in the pipelines and drafts files. | ts-5a8dd8 |
| Durable state beyond those files and foreman's own records is a wall | `AGENTS.md` same section | No conflict: plugin definitions are operator intention in the plugins file; run snapshots and started keys are foreman's own records. | ts-5a8dd8 |
| Absence that needs a person is a park | `AGENTS.md` park rule | An unmet plugin requirement is an attention row, not a park. It clears when the requirement appears. | ts-604c78 |
| Router is the only way to choose a route from facts | `docs/pipeline-engine.md`; `docs/agent-exits.md` | Router stays for filters and counts. A command block may also choose a route when the choice needs a process. | ts-44824b |
| Verify runs the merged tree's copy of `scripts/verify` | `src/repository.ts`, the doc comment of `scriptsOf` | A gate runs the target's copy (section 10). `worktree-setup` keeps the tree's copy. | ts-60a4e5 |
| A project's checks are only the scripts the operator names | this record, section 3 | Command sources offer the project's own names in the palette (section 9, proposal). | ts-627559 |

The cutover rule the review cited ("the pipelines and drafts files carry no
format version, and the one-time cutovers are deleted") is not in AGENTS.md or
`docs/`, so this record does not change it. The delete-the-check-kind decision
makes no cutover, so it does not conflict with that rule either way.

## Build slices

Filed under `ep-3ca01a` as drafts. Each waits on the one before it; the first
waits on this design record.

1. `ts-5a8dd8` — Plugins file Schema, load/save, `FOREMAN_PLUGINS`, and the
   AGENTS.md durable files list (plugins file + composites object).
2. `ts-44824b` — Pipeline `command` node, `check` plugin, deletion of
   `kind: "check"`, palette and `problemsOf` (unknown plugin, exits, params,
   missing `idempotent` on outside, withholding warning, `check` node refused).
3. `ts-ed85e7` — Runner: input Schema, stdout and `exitFromStatus` exit
   protocols, run row with snapshot, per-plugin `slots`, timeout, own fiber;
   proving-ground lock shared with land.
4. `ts-9aecc2` — Inside recovery per workspace mode (reset in `worktree` only;
   decision in `checkout` and `direct`); built-in `check` moved onto the runner
   with `compareBase`.
5. `ts-04727d` — Outside recovery: started record and invocation key before
   exec; idempotent retry vs decision.
6. `ts-604c78` — Requirements check and attention row.
7. `ts-f606c2` — Compensation on cancel, kill and branch reset, reverse order,
   from the run snapshot.
8. `ts-1a29b7` — Gate tests named in section 8.

Filed later, from sections 9 and 10, also as drafts:

- `ts-60a4e5` — Gates run the target's copy; the review prompt names changed
  gate files. Waits on the question `ts-5bed50` (charge or decision when the
  target's gate fails on a valid branch change).
- `ts-627559` — Command sources for `scripts/` and package.json, offered in the
  palette. Waits on `ts-44824b`, and on the operator confirming section 9.
- `ts-ae4224` — Command sources for other tooling. Waits on `ts-627559`.

## Checks

- A drawing with `kind: "check"` loads with one problem row naming
  `command` with `of: "check"`, and runs nothing.
- `problemsOf` on a pipeline that posts outside before a land returns one
  withholding warning and no hard problem.
- Killing the process of an `inside` command in a `worktree` between start and
  end leaves the branch at the tip recorded before the run, and the next tick
  runs it again.
- Killing an `inside` command in a `checkout` after it committed leaves a
  decision and the tree untouched.
- Killing an `outside` `idempotent: false` command after start leaves a
  decision, not a second run.
- Canceling a task after two outside runs ran compensate for the second, then
  the first.
