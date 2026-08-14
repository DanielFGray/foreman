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

**The busy count is global.** Foreman counts every `foreman/*` workspace herdr
is showing, including ones another daemon owns, so at `--slots 1` a live
workspace from your real session fills the only slot and the rig's reviewer is
never dispatched. Run the rig with the slots to spare, or take the real fleet
down first.
