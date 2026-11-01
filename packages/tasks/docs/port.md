# tasks: prog's task tracking, in the monorepo

Status: plan, accepted for build. Steps are committed one at a time.

## Why

foreman writes the progress of each run onto prog's tasks as labels: `by:`,
`review-by:`, `review-failed-by:`, `failed-by:`, `attempt:<rung>:<n>`,
`rounds:`, `walled:`, `diagnosing:`. Every reader parses them back out of strings,
and every read is a `prog` child process (one `prog show` per task, because
`prog list --json` returns empty labels). A pipeline engine would add more.

`tasks` is an Effect package that reads and writes the task store in process,
with a typed record of runs in place of those labels.

## Scope

- Ported: items, dependencies, labels, logs, projects; ready and its ranking;
  the derived status of an epic; the commands foreman and agents use on tasks.
- Not ported: learnings, concepts, context, prime, onboard, tui, web, backup.
  The Go `prog` keeps serving them.

## One store, two front ends, during the move

`tasks` opens the same SQLite file as `prog` (`PROG_DB`, else `~/.prog/prog.db`),
so every project's agents keep running `prog` while foreman moves to `tasks`.
It follows the rules the Go writer already follows on that file:

- **Connection.** `foreign_keys` on, `busy_timeout` 5000 ms, WAL journal (Go sets WAL on every open, and so does the Effect client).
  A write that fails with BUSY or LOCKED (or READONLY or CANTOPEN while the file
  exists) is retried: three attempts, jittered backoff from 100 ms.
- **Schema.** Go owns `PRAGMA user_version` and every table it created. `tasks`
  adds tables through Effect's `Migrator`, which records its own migrations in
  its own table and never touches `user_version`.
- **Timestamps.** Go writes item times as its `time.Time` string in local time
  (`2026-11-01 17:07:52.490666699 -0600 CST`, sometimes followed by a monotonic
  `m=+…` part); SQLite's `CURRENT_TIMESTAMP` writes log times in UTC
  (`2026-11-01 22:39:22`). Readers compare these as text. `tasks` writes each
  column in the layout already there, and parses both.
- **Derived status.** An epic's status is computed from its children on read,
  never stored; `blocked` is never written by a command. `tasks` computes it the
  same way.
- **IDs.** `ts-` or `ep-` and six random hex digits.

## Build order

1. **The `Tasks` service** over `effect/sql` (`@effect/sql-sqlite-bun`): items,
   deps, labels, logs, ready and rank. The dependency graph uses Effect's
   `Graph` (cycle check on `blocks`, topological order, Mermaid output).
   Pass criterion: a differential test that runs Go `prog` and `Tasks` on two
   copies of one database for every command foreman uses (ready, list, show,
   label, unlabel, start, review, open, done, log, add) and compares the JSON
   and the resulting rows.
2. **foreman's `Prog` layer runs in process.** `Prog` keeps its operations and
   runs them on `Tasks`; each label rewrite is one transaction. foreman uses
   `tasks`' `Item` directly, so no field mapping sits between them. Its queue
   ranks with `tasks`' `rank`.
3. **Runs.** A `runs` table (task, role, rung, start, end, outcome, verdict)
   replaces the dispatcher's labels. Open decision: the trials table in
   `~/.agents/model-trials.db` already records one row per run for the herd
   skill, so one of the two must be the authority.
4. **The `tasks` CLI**, for the commands agents run on tasks.
5. **The pipeline engine** (`feat/pipeline-engine`), placing tasks from runs.

## Rules this touches

- foreman AGENTS.md: "Durable state beyond the policy file is a wall ... the fix
  belongs in hc, herdr-app or prog." Kept, with prog read as `tasks`: the runs
  table is the task store recording what happened. The text needs the new name
  once the operator confirms it.
- foreman AGENTS.md, "Ports": "Nothing above that file builds a `prog` command
  line." Kept: `src/prog.ts` stays the one surface, with an in-process layer.
- The operator's CLAUDE.md and foreman's prompts name `prog` for task commands.
  They change to `tasks` at step 4, with the operator's confirmation.
