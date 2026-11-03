# The foreman panel for herdr-app

A right-hand dock that shows the fleet as the dispatcher last published it in
`state.json`, filtered to the shown space's project: the folder name of the git
checkout the space sits in, which the panel asks git for, so the filter holds
while no dispatcher runs. The Queue section is not in `state.json`: the panel runs
`foreman queue --project <name> --json` (or `foreman queue --json` for every
project) every 5 seconds and when the project changes, so it shows while no
dispatcher runs. Clicking a row runs `foreman show <id> --json` for the task's
description and log. The panel never runs `prog`. Each row's buttons run
`foreman <action> <id>`. A queued row also has `launch`, which shows the
ladder's rungs and dispatches to the one you pick. A row that newly appears
under Landed posts a notification.

An epic row leads with a "+" or "−" control. Collapsed (the default), the row
stands alone with its subtask count; expanded, it shows the epic's description
(read with `foreman show <id> --json` on each expand) and its subtasks. The
choice is per epic, holds across spaces and project filters, and is kept in the
mod's own `localStorage`.

The bar under the title is the policy: pause or resume, the four steps the
fleet takes for every task (author, climb, review, land; each chip cycles
on, ask, off), the agent limit, and
each grant with a revoke button. A review row has `allow review` and `allow
land`, which grant that one step for that one task. Every button runs
`foreman policy ...`, the same writer as the command line, and the dispatcher
reads the change on its next tick.

The title line says what the dispatcher is doing, as the file names it:
`running`, `paused`, `idle` (no step on and no grant, so it only reads),
`failed` (herdr-web's server is starting it again, and the reason shows under
the title), `stale` (no reading for two minutes), `no dispatcher` (the file
was written by a one-shot `foreman status`) or `offline` (no file).

The panel keeps no state. It reads the file that `src/published.ts` writes, and
the schema there is the contract; a row from `foreman queue --json` has the
shape of a published row. herdr-web's server writes the file, and its Foreman
page reads the same readings through its own copy of the schema. Bump `PUBLISHED_VERSION`, `VERSION` in
`foreman/main.js` and in `foreman-pipeline/main.js`, and `FOREMAN_VERSION` in
herdr-web's `src/shared/Foreman.ts` together.

## Install

1. Link the mod into the app's home, so it stays versioned with the schema:

   ```sh
   ln -s ~/build/foreman/packages/foreman/herdr/foreman ~/.config/herdr-app/mods/foreman
   ```

2. Add the panel to your own layout (not a shipped one, which herdr-app
   replaces on start), as the last child of the `panel-body` stack, beside
   Files and Changes:

   ```json
   { "id": "foreman", "type": "block", "content": { "mod": "foreman" } }
   ```

3. Give the tab bar a Foreman button. The shipped `tabs` mod draws buttons
   for Files and Changes only, and when the space changes it hides any other
   panel in that stack. So clone it, point your layout's `tabs` block at the
   clone, and in the clone's `main.js` add `"foreman"` to `enabled` and a
   `panelButton("foreman", "Foreman", "mods/foreman/foreman.svg")` child
   after the Changes one. To keep the panel open or closed across spaces,
   which suits a fleet-wide view, also delete the clone's `syncPanel` method,
   its call in `render`, and the `panels` it reads in `init`: they restore a
   per-space choice on every space switch.

   ```sh
   herdr-app do mod.clone '{"name":"tabs","as":"tabs-dfg"}'
   ```

   The button then opens and closes the panel, and each space remembers it,
   the same as Files and Changes.

## Props

Both are optional, and are set on the block's `content.props`:

- `state`: the published file. Default: `~/.local/state/foreman/state.json`,
  where herdr-web's server writes it when it has no `XDG_STATE_HOME` or
  `FOREMAN_STATE`.
- `command`: the argv prefix that runs foreman. Default: `["foreman"]`. A mod
  cannot read environment variables, so a fleet with its own registry or
  config is reached through `env`:
  `["env", "FOREMAN_CONFIG=/abs/config.jsonc", "FOREMAN_POLICY=/abs/policy.json", "bun", "/abs/src/main.ts"]`.

## The pipeline pane

`foreman-pipeline/` is a second mod: one project's pipeline as a pane, with the
tasks that stand at each block (the dispatcher's placements in `state.json`).
The panel's `pipeline` button opens it beside the focused pane for the shown
space's project, or run
`herdr-app do pane.split '{"direction":"right","mod":"foreman-pipeline","props":{"project":"<name>"}}'`.
Zoom the pane to give it the whole tab. Link it like the panel:

```sh
ln -s ~/build/foreman/packages/foreman/herdr/foreman-pipeline ~/.config/herdr-app/mods/foreman-pipeline
```

It draws the `drawing` that `foreman pipeline show <project> --json` prints
(`src/pipeline-layout.ts`): every box and wire route in pixels. A mod cannot
load foreman's modules, because the mod engine has no `TextEncoder`, so the
layout is foreman's and the pane lays nothing out. The pane asks for
`--flow down` (top to bottom) when it is taller than it is wide, and for
`--flow across` (left to right) otherwise, and asks again when its shape
flips. It takes `state` and
`command` props like the panel, and `project`.

`edit` changes the project's draft, never the pipeline it runs. Click a "+" on
a wire to put a block there, or a block to change its settings, remove it, or
point one of its exits at another block. Each change runs
`foreman pipeline edit <project> '<change>' --json`, which answers the new
reading. While a draft is open the pane draws it and lists its problems;
`save` runs `foreman pipeline save`, which checks the draft and makes it the
pipeline the project runs, and `discard` drops it. The draft is foreman's
file, so it outlives the pane.

## What it does not do yet

- `complete` and `intervene` need an answer the panel has no input for. Run
  them from the command line.
- Grants for an epic, and a count on a grant, are set with
  `foreman policy grant` from the command line. The panel grants one task
  one step at a time.
