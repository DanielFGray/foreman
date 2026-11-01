# The foreman panel for herdr-app

A right-hand dock that shows the fleet as the daemon last published it in
`state.json`, filtered to the shown space's project. Each row's buttons run
`foreman <action> <id>`. A queued row also has `launch`, which shows the
ladder's rungs and dispatches to the one you pick. A row that newly appears
under Landed posts a notification.

The bar under the title is the policy: pause or resume, the four steps the
fleet takes for every task (author, climb, review, land), the agent limit, and
each grant with a revoke button. A review row has `allow review` and `allow
land`, which grant that one step for that one task. Every button runs
`foreman policy ...`, the same writer as the command line, and the daemon
reads the change on its next tick.

The panel keeps no state. It reads the file that `src/published.ts` writes, and
the schema there is the contract. herdr-web's Foreman page reads the same file,
through its own copy of the schema. Bump `PUBLISHED_VERSION`, `VERSION` in
`foreman/main.js`, and `FOREMAN_VERSION` in herdr-web's `src/shared/Foreman.ts`
together.

## Install

1. Link the mod into the app's home, so it stays versioned with the schema:

   ```sh
   ln -s ~/build/foreman/herdr/foreman ~/.config/herdr-app/mods/foreman
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
   after the Changes one:

   ```sh
   herdr-app do mod.clone '{"name":"tabs","as":"tabs-dfg"}'
   ```

   The button then opens and closes the panel, and each space remembers it,
   the same as Files and Changes.

## Props

Both are optional, and are set on the block's `content.props`:

- `state`: the published file. Default: `~/.local/state/foreman/state.json`,
  where a daemon with no `XDG_STATE_HOME` or `FOREMAN_STATE` writes it.
- `command`: the argv prefix that runs foreman. Default: `["foreman"]`. A mod
  cannot read environment variables, so a daemon with its own registry or
  config is reached through `env`:
  `["env", "FOREMAN_CONFIG=/abs/config.jsonc", "FOREMAN_POLICY=/abs/policy.json", "bun", "/abs/src/main.ts"]`.

## What it does not do yet

- `complete` and `intervene` need an answer the panel has no input for. Run
  them from the command line.
- Grants for an epic, and a count on a grant, are set with
  `foreman policy grant` from the command line. The panel grants one task
  one step at a time.
