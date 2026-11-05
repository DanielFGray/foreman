# tasks: the local task store

`tasks` is the local task tracker. Its store path is `TASKS_DB`, or
`~/.tasks/tasks.db` when that variable is unset. It can read stores created by
the Go `prog` tool.

## Why it exists

`tasks` is an Effect package that reads and writes the store in process. It
stores runs as typed records beside task data.

## Scope

- Items, dependencies, labels, logs, projects, ready work and its ranking;
  the derived status of an epic; the commands foreman and agents use on tasks;
  the `tasks` CLI; the runs, charges and parks tables foreman owns beside it.
- Migration `0013_no_learnings` drops learning, concept and context tables from
  Go `prog` stores. The `tasks` CLI has no commands for those records.

## Store rules

- **Connection.** `foreign_keys` on, `busy_timeout` 5000 ms, WAL journal.
  A write that fails with BUSY or LOCKED (or READONLY or CANTOPEN while the file
  exists) is retried: three attempts, jittered backoff from 100 ms.
- **Schema.** Effect's `Migrator` owns the tables, recorded in
  `tasks_migrations`. `0001_tasks` creates the task tables.
- **Timestamps.** Item times use the Go `time.Time` local layout;
  log times use SQLite `CURRENT_TIMESTAMP` (UTC). Readers compare these as text.
- **Derived status.** An epic's status is computed from its children on read,
  never stored; `blocked` is never written by a command.
- **IDs.** `ts-` or `ep-` and six random hex digits.

