# The end-to-end rig

`config.jsonc` points foreman at one scratch project and nothing else, so a
daemon started with it cannot see the real backlog. That is the whole point:
two earlier verification runs claimed real tasks that had to be unwound by
hand.

```
foreman --config e2e/config.jsonc --slots 1
```

The project is `~/build/foreman-e2e-probe`, a git repository with a green
`bun test`. File a task in the prog project of the same name at priority 2 —
below 3, so it needs a review — and watch it go author → review → approved →
merge → done. The proof is in the probe checkout afterwards: a merge commit,
the author's file present, no `foreman/*` branch left and a clean tree.

The busy count is scoped to the rig's own config. Foreman counts only the
`foreman/*` workspaces whose task lives in a project the running config
manages, so live workspaces from another daemon do not fill the rig's slots at
`--slots 1`.
