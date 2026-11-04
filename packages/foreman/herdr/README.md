# The Foreman pane for herdr-app

One mod, `foreman/`, that shows the project of the shown herdr-app space: the
folder name of the git checkout the space sits in, which the pane asks git for,
so it holds while no dispatcher runs. It follows the space when you switch.

## The header

Over every view: the view switch (Pipeline / Tasks / Models), the project,
what the dispatcher is doing, the age of its last reading, pause or resume,
the agent limit, and the `fleet defaults` chip. The chip opens a strip with
each step's fleet-wide mode (author, climb, review, publish, land; each chip
cycles on, ask, off with `foreman policy set <step> <mode>`) and each grant
with a revoke button.

The dispatcher's state is as the file names it: `running`, `paused`, `idle`
(no step on and no grant, so it only reads), `failed` (herdr-web's server is
starting it again), `stale` (no reading for two minutes), `no dispatcher` (the
file was written by a one-shot `foreman status`) or `offline` (no file).

Under it, the alerts: a policy file that cannot be read, a failed dispatcher
and why, a tracker that did not answer for this project, and the problems that
stop this project's pipeline.

## The views

- **Pipeline** draws the `drawing` that `foreman pipeline show <project>
  --json` prints (`src/pipeline-layout.ts`), with the tasks that stand at each
  block (the dispatcher's placements in `state.json`). Each gate shows the mode
  its step has for this project, which `state.json` publishes in
  `projects[].steps`; a click sets the next mode with `foreman policy set
  <step> <mode> --project <project>`. A mod cannot load foreman's modules,
  because the mod engine has no `TextEncoder`, so the layout is foreman's and
  the pane lays nothing out. The pane asks for `--flow down` when it is taller
  than it is wide, and `--flow across` otherwise.

  `edit` changes the project's draft, never the pipeline it runs. Click a "+"
  on a wire to put a block there, or a block to change its settings, remove
  it, or point one of its exits at another block. Each change runs `foreman
  pipeline edit <project> '<change>' --json`. `save` runs `foreman pipeline
  save`, which checks the draft and makes it the pipeline the project runs, and
  `discard` drops it. `simulate` walks a pretend task through the draft, and
  `fleet` plays the project's real tasks through it.

- **Tasks** has two modes, picked by a switch inside it, and the pane keeps
  the last one picked in its own `localStorage`.
  - **Board**: the dispatcher's six board columns. Drag a Queue card onto
    Authoring to grant it the steps the pipeline gates on. In each column, an
    epic's cards follow its head (its title and how many of its tasks are
    done); a click on the head folds the epic in every column, and the pane
    keeps the fold. Click a card to open its detail under the board:
    the task's record from `foreman show <id> --json` (facts, description,
    definition of done, the last three logs), its page, its pull request,
    every action its row takes (`foreman <action> <id>`; `kill`, `close` and
    `release` arm on the first click), `launch` with a rung picker
    (`foreman dispatch <id> --rung <rung>`) for a Queue card, and an
    `allow <step>` chip for each gate an ask holds it at.
  - **Graph**: the project's open and claimed tasks by what each waits for
    (`foreman pipeline graph <project> --json`). Pick cards, then `send
    through` grants each one the pipeline's gated steps.

- **Models** (`foreman ladder --json`): a column per ladder level that holds
  an enabled rung, cheapest first; Available, every disabled rung and every
  model no rung or reviewer names; and Reviewers. Available and Reviewers stay
  at the right edge, and the level columns scroll across under them, so a rung
  in any level can reach both. Each change is a drag:
  - A rung dropped on a level column joins that level (`foreman ladder
    level`). Dropped on the gap between two level columns, or before the first
    or after the last, it takes a level of its own there (`foreman ladder
    move`). A disabled rung is enabled after the move (`foreman ladder
    enable`), and an enabled rung dropped on Available is disabled.
  - A model dropped in a level or a gap becomes a rung there (`foreman ladder
    add`, with `--level` to join a level), named after the model unless that
    name is taken, with no thinking level.
  - A rung or a model dropped on Reviewers runs `foreman reviewers add`, with
    the rung's thinking level for a rung; a reviewer dropped on Available runs
    `foreman reviewers remove`.

  A click on a rung's or a reviewer's thinking level steps it none, low,
  medium, high, none (`foreman ladder thinking`, `foreman reviewers
  thinking`). Under the columns are the accounts the ladder and the reviewers
  draw on: what each has left (the quota rows) and the rungs and reviewers it
  pays for.

The queue is not in `state.json`: the pane runs `foreman queue --project
<name> --json` every 5 seconds. A row that newly appears under Landed, in any
project, posts a notification. The pane never runs `prog`.

The pane keeps no state but the Tasks mode. It reads the file that
`src/published.ts` writes, and the schema there is the contract; a row from
`foreman queue --json` has the shape of a published row. herdr-web's server
writes the file. Bump `PUBLISHED_VERSION` and `VERSION` in `foreman/main.js`
together.

## Install

1. Link the mod into the app's home, so it stays versioned with the schema:

   ```sh
   ln -s ~/build/foreman/packages/foreman/herdr/foreman ~/.config/herdr-app/mods/foreman
   ```

2. Open it beside the focused pane, and zoom the pane to give it the whole tab:

   ```sh
   herdr-app do pane.split '{"direction":"right","mod":"foreman"}'
   ```

## Props

Both are optional:

- `state`: the published file. Default: `~/.local/state/foreman/state.json`,
  where herdr-web's server writes it when it has no `XDG_STATE_HOME` or
  `FOREMAN_STATE`.
- `command`: the argv prefix that runs foreman. Default: `["foreman"]`. A mod
  cannot read environment variables, so a fleet with its own registry or
  config is reached through `env`:
  `["env", "FOREMAN_CONFIG=/abs/config.jsonc", "FOREMAN_POLICY=/abs/policy.json", "bun", "/abs/src/main.ts"]`.

## What it does not do yet

- `complete` and `intervene` need an answer the pane has no input for. Run
  them from the command line.
- A count on a grant is set with `foreman policy grant` from the command line.
