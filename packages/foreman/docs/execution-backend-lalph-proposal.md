# Proposal: an execution-backend seam for lalph

Filed upstream: [tim-smart/lalph#469](https://github.com/tim-smart/lalph/issues/469)

lalph runs coding agents two ways today, and only one of them is expressible in
its source. This proposal adds a seam — an execution backend — so the second way
becomes a plugin instead of a fork.

## The two execution models

### spawn-and-pipe (what lalph does today)

`CliAgent` (`src/domain/CliAgent.ts`) is a `ChildProcess.Command` factory:

```ts
command?: (options: {
  prompt: string
  prdFilePath: string | undefined
  extraArgs: ReadonlyArray<string>
}) => ChildProcess.Command
```

Every agent — chooser, worker, reviewer, timeout, tasker — builds a command,
sets its cwd to the worktree, applies the preset's command prefix, and hands it
to one of the `Worktree` exec helpers (`execWithOutput`,
`execWithWorkerOutput`, `execWithStallTimeout` in `src/Worktree.ts`). Those
helpers spawn the process, pipe its combined stdout+stderr through the agent's
`outputTransformer` (claude's stream-json filter, otherwise identity), apply a
stall timeout, write the chunks to the worker output atom, and return
`handle.exitCode`.

Completion is an exit code. Progress is a byte stream. The worktree is created
by lalph itself (`git worktree add` in `Worktree.make`). The process is lalph's.

### multiplexer-and-poll (herdr)

[herdr](https://herdr.dev) inverts all of it. It owns the terminal, the
workspace, the worktree, the pane, and the agent process. An orchestrator does
not spawn anything:

- `herdr worktree create` makes the worktree, branch, workspace and label in one
  call.
- `herdr agent start` launches the agent inside a pane.
- `herdr agent prompt --wait --until working` delivers the prompt and waits
  until the agent is actually on it.
- the orchestrator polls `agent_status` (`idle` / `working` / `blocked` /
  `done` / `unknown`) instead of reading an exit code.

There is no exit code. There is no stdout pipe lalph can read — the output is
the terminal pane. The worktree is herdr's.

## Why they cannot coexist behind lalph's current seam

Every property of the seam differs:

| | spawn-and-pipe | multiplexer-and-poll |
| --- | --- | --- |
| who owns the process | lalph (`ChildProcess.Command`) | the multiplexer |
| output channel | stdout/stderr stream | the terminal pane |
| completion signal | exit code | `agent_status` polled, verdict from the task store |
| worktree owner | lalph (`git worktree add`) | the multiplexer |
| prompt delivery | argv | a prompt command |

The seam is `CliAgent.command → ChildProcess.Command → exit code`. A
multiplexer backend has none of those. Writing one today means writing a second
orchestrator that reimplements lalph's task selection, worktree, review and
merge loop against a different process model — which is exactly what foreman (a
dispatcher built on herdr) had to do.

## The proposal: an execution backend

Introduce a service seam in lalph that both models implement. Foreman's `Fleet`
port (`src/fleet.ts`) is the working prototype of the multiplexer-and-poll half,
and it has run real agents end to end:

```ts
// foreman/src/fleet.ts, condensed
readonly open: (options) => Effect<Worker, FleetError>     // workspace + worktree for a task
readonly attach: (options) => Effect<Worker, FleetError>   // workspace over an existing checkout
readonly spawn: (worker, options) => Effect<AgentIdentity, FleetError>
readonly roster: Effect<ReadonlyArray<Worker>, FleetError> // poll state every tick
readonly focus: (worker) => Effect<void, FleetError>       // bring to front for a human
readonly close: (worker) => Effect<void, FleetError>       // worktree-aware teardown
readonly notify: (title, body) => Effect<void, FleetError>
```

The agent workers in lalph would talk to this seam instead of building
`ChildProcess.Command` directly. Two implementations:

- **spawn-and-pipe backend**: today's behavior, unchanged. `spawn` = build the
  `CliAgent` command, run it through the existing exec helpers, derive
  completion from the exit code. Worktree ownership stays where it is.
- **multiplexer-and-poll backend**: `spawn` = `herdr agent start` +
  `herdr agent prompt --wait --until working`; `roster` = poll `agent_status`;
  completion is decided by re-reading the task store, never by a process exit.
  Worktree ownership moves to the multiplexer (`herdr worktree create`).

The seam deliberately does **not** define completion. "Settled is settled;
what the agent actually achieved is written in the task store" is the foreman
rule that makes the two models meet. An exit code is one source of truth for
spawn-and-pipe; a GitHub/Linear state transition is the one for a multiplexer.
The orchestrator re-reads the world either way.

Stall detection moves behind the seam too: output-stream inactivity for
spawn-and-pipe (`withStallTimeout`), `blocked` / stale `working` status for a
multiplexer.

## What stays the same

- `CliAgent` presets, command prefixes, extra args, label routing.
- The clanka in-process path (`runClanka`) — a third backend, not a special
  case bolted onto `CliAgent.command` absence.
- All existing agent prompts and git flow.
- Default behavior for existing users: the spawn-and-pipe backend is the
  default, configured exactly as today.

## Working prototype

- `foreman/src/fleet.ts` — the seam.
- `foreman/src/herdr.ts` — the herdr implementation, including `agent_status`
  aggregation (`workerStateOf`) and the two-stream/exit-code handling herdr's
  CLI requires.
- `foreman/src/dispatcher.ts` — the orchestrator written against the seam.

foreman dispatches live agents against a real backlog through this seam today.
It is not a sketch.

## Open questions for lalph

1. Where does the seam live relative to `Worktree`? lalph's `Worktree` both
   creates the worktree and execs into it; a multiplexer owns the worktree.
   The seam must own "where the agent runs" so `open` can hand that choice to
   the backend.
2. Do chooser/tasker/reviewer roles share one backend per project, or does the
   backend become a per-preset property alongside `cliAgent`?
3. Should the seam be an Effect service tag, or a strategy field on
   `CliAgentPreset`? foreman's prototype uses a service tag.
4. Does plan mode (`commandPlan`) need a backend too, or stay spawn-and-pipe?

## Related

- lalph issue #163 discussed "multiple runner strategies, where there is always
  a single orchestrator". This proposal is that, scoped to a single seam.
- herdr is one multiplexer. The same seam would admit any multiplexer with a
  CLI or socket, and remote runners (effect cluster) later.
