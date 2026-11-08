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
  branch, which foreman can reset. `outside` means an emission foreman cannot
  take back.
- **requirement**: a coeffect the plugin declares (an environment variable, a
  binary on `PATH`, a login). A block whose requirements are unmet does not
  run.

## 1. One block kind

The pipeline node kind is `command`. A check is a command block of the built-in
plugin `check`, with exits `passed` and `failed` and the base-commit comparison
foreman already runs for checks.

The **router stays**. A router is instant and reads facts (counts, failures,
labels). A command that chooses a route is for a choice that needs a process:
external state, a binary, or logic a filter cannot express. Replacing routers
with commands would turn every `exits:returned>=3` into a process spawn. Counts
and filters stay on the router; judgment that needs a command is a command
block.

An existing `kind: "check"` node is sugar for

```jsonc
{ "kind": "command", "id": "lint", "of": "check",
  "set": { "command": "./scripts/lint.sh" },
  "exits": [
    { "id": "passed", "name": "passed", "to": "land-gate" },
    { "id": "failed", "name": "failed", "to": "queue", "fails": "author" }
  ] }
```

`problemsOf` and the palette speak `command`. The first pipeline save after the
cutover rewrites each `check` node to that form, so drawings hold one kind.

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

The command names its exit on standard output: the first line is an exit id the
block declares. Process status 0 means that exit stands. A non-zero status is a
process failure, not an exit name: recovery follows the plugin's boundary. A
line that is not a declared exit is a process failure too.

The built-in `check` plugin keeps today's tip and base comparison inside
foreman. It runs the operator's `command` parameter in the proving ground, maps
status to `passed` or `failed`, and does not require that parameter's process to
speak the stdout protocol. Every other plugin speaks the protocol above.

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
      "compareBase": true,
      "exits": [
        { "id": "passed", "name": "passed" },
        { "id": "failed", "name": "failed" }
      ],
      "params": [
        { "name": "command" }
      ],
      "requirements": [],
      "timeoutMinutes": 30
    },
    "notify-landed": {
      "command": "~/.config/foreman/plugins/notify-landed.sh",
      "boundary": "outside",
      "ground": "none",
      "idempotent": true,
      "exits": [{ "id": "sent", "name": "sent" }],
      "params": [],
      "requirements": [
        { "kind": "env", "name": "SLACK_BOT_TOKEN" },
        { "kind": "bin", "name": "curl" }
      ],
      "compensate": "~/.config/foreman/plugins/notify-landed-undo.sh",
      "timeoutMinutes": 2
    }
  }
}
```

- **`command`**: the argv foreman runs. Required unless `compareBase` is true.
  No shell unless the operator's script starts one.
- **`boundary`**: `inside` or `outside`.
- **`ground`**: where the process's working directory is. `worktree` is the
  task's worktree or checkout. `proving` is the project's proving ground at the
  tip. `none` is foreman's own directory (no project tree).
- **`compareBase`**: only the built-in check uses this. Foreman runs the
  parameter `command` in the proving ground and applies today's tip / base
  comparison. The plugin entry has no argv of its own.
- **`idempotent`**: for `outside` only. When true, the invocation key makes a
  second run safe and foreman retries a started-with-no-end run with the same
  key. When false, that case is a decision for the operator.
- **`compensate`**: optional undo command. Same input Schema, plus the exit the
  forward run named when it finished.
- **`requirements`**: `env`, `bin`, or `login` (a named login probe foreman
  already knows how to ask, such as `gh auth`). Secrets are environment values
  only. The pipelines file and the plugins file never hold them.
- **`timeoutMinutes`**: wall clock from start. Default 10. A timeout is a
  process failure for recovery.
- **`slots`**: optional cap on how many of this plugin's blocks run at once,
  inside the fleet's `slots`, as an agent block's `slots` does.

The palette offers each plugin as a block kind. `problemsOf` checks that a
pipeline's `of` names a plugin, that every wired exit id is declared, that each
required parameter is set, and that an `outside` plugin with no `idempotent`
field is refused (the operator must say whether a retry is safe).

## 4. The system boundary

Each plugin declares where its effects fall. The boundary decides recovery:
whether foreman can restore the state before the run.

### Inside

Effects are commits on the task's own branch (and uncommitted edits in its
worktree). Foreman records the tip before the run. After a process failure or a
crash (a started run with no end), it resets the branch and the worktree to that
tip and runs again. The proving ground is disposable, so a `ground: proving`
inside plugin needs no tip reset of the task branch; a started-with-no-end run
is simply tried again.

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

A plugin may name a `compensate` command. When the task's work is abandoned
(`cancel`, `kill`, or a reset that drops the branch), foreman runs each finished
outside run's compensate command in reverse order of those runs, with the same
invocation key and the exit that run named. A compensate process failure is
logged and the next compensate still runs; the task's abandon does not wait on
a perfect undo. Inside runs need no compensate: the tip reset is the undo.
Unfinished (started-with-no-end) outside runs are not compensated; they follow
the uncertain-case rule above first.

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

## 6. Binding

A run records the hash of the plugin definition it started with (canonical JSON
of that plugin's entry). An edit to the plugins file during a run does not
change what that run means: settle, recovery and compensation read the hash
from the run, and refuse to apply a different definition to it. New runs read
the file as it is now. The hash is foreman's, not the plugin author's.

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
- **Slots.** A running command takes a fleet slot, as an agent does. A plugin's
  optional `slots` caps that plugin's concurrent runs. Today's check took no
  slot; that ends with this record, because an unbounded pile of commands is
  the same resident-memory problem agents already have.
- **Timeout.** `timeoutMinutes` on the plugin (default 10). On timeout foreman
  kills the process and treats it as a process failure for recovery.

## 8. Tests

The gate covers, as unit tests over the runner with a fake command:

- For an `inside` plugin: a crash between "started" and the end resets the
  branch to the recorded tip and runs again; the second run's commits are the
  ones that remain.
- For an `outside` plugin with `idempotent: true`: a started-with-no-end run is
  retried with the same invocation key, and the command receives that key both
  times.
- For an `outside` plugin with `idempotent: false`: a started-with-no-end run
  becomes a decision and is not retried.
- Compensation runs in reverse order of finished outside runs when a task is
  canceled, and a failing compensate does not skip the rest.
- An unmet requirement publishes the attention row and runs no command; when
  the requirement appears, the next tick runs it.

No test starts `foreman serve`.

## What it replaces, and conflicts

Each rule below is changed by this record. The record wins in each case.

| Rule | Where it stands | Change |
| --- | --- | --- |
| Check is its own block kind with `command` and exits `passed` / `failed` | `src/pipeline.ts` `CheckNode`; `docs/pipeline-engine.md` Blocks; `docs/agent-exits.md` Check block | One kind `command`. `check` is a built-in plugin, and a `kind: "check"` node is sugar rewritten on save. |
| A check gets no task context | epic `ep-3ca01a`; `runCheck` in `src/dispatcher.ts` | Standard input carries the task JSON for every command plugin. The built-in check keeps tip / base comparison in foreman. |
| A check takes no slot | `docs/pipeline-engine.md` Blocks table; settle path in `src/dispatcher.ts` | A command takes a fleet slot. A plugin may set `slots`. |
| Landings and checks are serialised by the dispatcher's one fiber over one proving ground per project | `AGENTS.md` Front ends | Landings and `ground: proving` commands share the proving-ground lock. Each command runs on its own fiber. The tick fiber does not wait out a non-proving command. |
| The durable intention files are the policy, pipelines, drafts and instructions files | `AGENTS.md` "The world holds the work" | Those four, plus the plugins file. The same paragraph names the composites object in the pipelines and drafts files. |
| Durable state beyond those files and foreman's own records is a wall | `AGENTS.md` same section | No conflict: plugin definitions are operator intention in the plugins file; run hashes and started keys are foreman's own records. |
| A check's command is judged only by exit status | `CheckNode` doc comment; `repository.check` | General plugins name an exit on stdout. Status 0 accepts it. The built-in check still maps status through tip / base comparison. |
| Absence that needs a person is a park | `AGENTS.md` park rule | An unmet plugin requirement is an attention row, not a park. It clears when the requirement appears. |
| Router is the only way to choose a route from facts | `docs/pipeline-engine.md`; `docs/agent-exits.md` | Router stays for filters and counts. A command block may also choose a route when the choice needs a process. |

## Build slices

Filed under `ep-3ca01a` as drafts. Each waits on the one before it; the first
waits on this design record.

1. `ts-5a8dd8` — Plugins file Schema, load/save, `FOREMAN_PLUGINS`, and the
   AGENTS.md durable files list (plugins file + composites object).
2. `ts-44824b` — Pipeline `command` node, `check` sugar, palette and
   `problemsOf` (unknown plugin, exits, params, missing `idempotent` on
   outside, withholding warning).
3. `ts-ed85e7` — Runner: input Schema, stdout exit protocol, run row with
   plugin hash, slots and timeout, own fiber; proving-ground lock shared with
   land.
4. `ts-9aecc2` — Inside recovery: tip snapshot, reset, retry; built-in `check`
   moved onto the runner with `compareBase`.
5. `ts-04727d` — Outside recovery: started record and invocation key before
   exec; idempotent retry vs decision.
6. `ts-604c78` — Requirements check and attention row.
7. `ts-f606c2` — Compensation on cancel, kill and branch reset, reverse order.
8. `ts-1a29b7` — Gate tests named in section 8.

No operator question was left open: the epic already recorded the four jobs,
the local plugins file, and the paper 6.1 recovery source; this record decides
the rest.

## Checks

- A drawing with `kind: "check"` loads, and the next save writes `kind:
  "command", "of": "check"`.
- `problemsOf` on a pipeline that posts outside before a land returns one
  withholding warning and no hard problem.
- Killing the process of an `inside` command between start and end leaves the
  branch at the tip recorded before the run, and the next tick runs it again.
- Killing an `outside` `idempotent: false` command after start leaves a
  decision, not a second run.
- Canceling a task after two outside runs ran compensate for the second, then
  the first.
