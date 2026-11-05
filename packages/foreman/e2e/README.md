# The end-to-end rig

`config.jsonc` points foreman at one scratch project and nothing else, so a
dispatcher started with it cannot see the real backlog. That is the whole point:
two earlier verification runs claimed real tasks that had to be unwound by
hand.

```
export TASKS_DB=/tmp/foreman-e2e.db   # the rig's own task store
# migrations create the schema on first open
bun src/main.ts ladder list         # opens the store once, which migrates it
sqlite3 "$TASKS_DB" < e2e/registry.sql
export FOREMAN_POLICY=/tmp/foreman-e2e-policy.json
bun src/main.ts policy slots 1
bun src/main.ts policy set author on   # and review, land: what the run should prove
export FOREMAN_CONFIG=$PWD/e2e/config.jsonc FOREMAN_STATE=/tmp/foreman-e2e-state.json
bun src/main.ts serve
```

The rig runs a second `foreman serve` with the rig's variables. Its lock sits
beside the rig's state file, so it runs beside the operator's service. Never
point it at the real state file.

`registry.sql` is a three-rung scratch ladder, so the rig climbs without
touching the real registry; `TASKS_DB` keeps the rig's tasks and runs out of the real store too.

The project is any git checkout whose folder name matches the tasks project
(for example `foreman-e2e-probe` somewhere on disk), with a green `bun test`.
Open a herdr-app space on that checkout. File a task in the project of the
same name at priority 2 — below 3, so it needs a review — and watch it go
author → review → approved → merge → done. The proof is in the probe checkout
afterwards: a merge commit, the author's file present, no `foreman/*` branch
left and a clean tree.

The busy count is scoped to the rig's own config. Foreman counts only the
`foreman/*` workspaces whose task lives in a project the running config
manages, so live workspaces from another dispatcher do not fill the rig's one slot.

The policy file is separate from your own: without `FOREMAN_POLICY` the rig
would read and write `~/.config/foreman/policy.json`.
