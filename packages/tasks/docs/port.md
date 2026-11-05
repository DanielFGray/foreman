# tasks: the local task store

Status: cut over. `tasks` is the independent task tracker for this monorepo.
Its file is `TASKS_DB`, else `~/.tasks/tasks.db`. It does not share a store with
the former Go `prog` tool.

## Why it exists

Before runs, foreman wrote the progress of each run onto task labels (`by:`,
`review-by:`, and the rest). Every reader parsed those strings, and every read
was a child process. `tasks` is an Effect package that reads and writes the
store in process, with a typed record of runs in place of those labels.

## Scope

- Present: items, dependencies, labels, logs, projects; ready and its ranking;
  the derived status of an epic; the commands foreman and agents use on tasks;
  the `tasks` CLI; the runs, charges and parks tables foreman owns beside it.
- Not yet: learnings, concepts, context, onboard, tui, web, backup.

## Store rules

- **Connection.** `foreign_keys` on, `busy_timeout` 5000 ms, WAL journal.
  A write that fails with BUSY or LOCKED (or READONLY or CANTOPEN while the file
  exists) is retried: three attempts, jittered backoff from 100 ms.
- **Schema.** Effect's `Migrator` owns the tables, recorded in
  `tasks_migrations`. `0001_tasks` creates the item layout the former Go tool
  used, so an empty file becomes a usable store.
- **Timestamps.** Item times use the former Go `time.Time` local layout;
  log times use SQLite `CURRENT_TIMESTAMP` (UTC). Readers compare these as text.
- **Derived status.** An epic's status is computed from its children on read,
  never stored; `blocked` is never written by a command.
- **IDs.** `ts-` or `ep-` and six random hex digits.

## Operator cutover from Go `prog`

```bash
mkdir -p ~/.tasks
# stop foreman serve first
mv ~/.prog/prog.db ~/.tasks/tasks.db
```

After that move, this monorepo does not read `PROG_DB` or `~/.prog`.
