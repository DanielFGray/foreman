# The web UI

The **web UI** is the operator's page for foreman in a web browser.
`foreman serve` serves it, on this machine only. It shows the queue, the fleet,
the ladder and each project's pipeline, and it edits pipelines, drafts,
composites, the policy and the ladder. herdr-web is a separate project, and this
record does not change it.

The herdr-app Foreman pane (`herdr/foreman/`) is frozen while the operator
decides which features stay in the pane and which move to the page. Until then
the pane gets no new features and no fixes, except that its Pipeline tab opens the page (`foreman open <project>`). It reads `state.json` as it does
now.

## Terms

- **page**: the browser program in `packages/foreman-ui`.
- **UI server**: the HTTP and WebSocket server inside `foreman serve` that
  serves the page and answers its calls.
- **contract**: the `RpcGroup` that the page and the UI server share. Each
  procedure has Schemas for its payload, its success and its failure, so the
  contract is both the list of routes and the definition of every message.
- **verb**: one thing the operator can do, such as `PipelineEdit`,
  `PolicyGrant` or `Approve`. Each verb is one plain Effect function in foreman.
  The CLI command and the contract's handler both call it.
- **readings**: the dispatcher's published state, the `Published` value that
  `state.json` holds (`src/published.ts`).

## Libraries

- **The page is React 19 with dragology.** dragology
  (https://declarative-dragging.github.io/) does declarative dragging on SVG.
  For a drag, the page lists the states the drop can give, and dragology
  previews the closest, snaps to it, and animates the move. dragology needs
  React. Every drag view of the pane (the Tasks board, the Models board, the
  pipeline editor) uses declarative dragging, so React is the page's one view
  library. foldkit was the first choice, and herdr-web uses it. foldkit could
  hold dragology only through its `Mount` seam, which would put the pipeline
  editor, the main part of the page, in a second framework with its own state.
- **dragology is pinned to 0.2.0 exactly.** It has no documentation besides
  its demos and `docs/AGENTS.md` in its package, and its API can change in any
  release. An upgrade is its own task.
- **Effect runs on both sides.** The page uses Effect 4's `Atom` with
  `@effect/atom-react` for state, `AtomRpc` for the contract's client, and
  `@effect/platform-browser` for the WebSocket. `@effect/atom-react` 4.1.2 needs
  `effect ^4.1.2`, so the whole workspace moves from Effect 4.1.0 to 4.1.2 in
  the first change, before any page code.

## The contract

`src/ui-contract.ts` in foreman holds the `RpcGroup`. foreman owns it because
its Schemas are foreman's: `Published`, `PipelineChange`, `Drawing`,
`Composites`, the policy and the ladder.

The procedures are of two kinds:

- **Streams**, which send a value at once and again at each change:
  - `Readings`: each new `Published` value.
  - `Pipeline { project }`: what `foreman pipeline show --json` prints for the
    project, sent again when the pipelines file, the drafts file or the
    instructions folder changes.
  - `Queue { project }`: what `foreman queue --json` prints, sent again with
    each reading.
- **Verbs**, which reply once. The first set is what the pane runs today
  (`rg 'foreman\(' herdr/foreman`):
  - pipeline: show, edit, save, discard, instructions, prompt, trace,
    simulate, graph;
  - composite: show, edit, save, discard, prompt;
  - policy: set, grant, revoke, slots, pause and resume;
  - ladder: list, add, move, level, enable, disable, thinking;
  - reviewers: add, remove, thinking;
  - tasks: show, dispatch, approve and the other row actions in `ACTIONS_LIST`
    (`src/view.ts`).

A verb's failure is its tagged error, the same one the CLI prints. A refused
`PipelineEdit` therefore replies with the problems that `problemsOf` names.

## One code path per verb

Today the work of each CLI command is inside its `Command.make` handler, with
private helpers (for example `freshDraft` and `runPipeline` in
`src/pipeline-command.ts`). Each verb moves out into an exported Effect function
that takes the decoded payload and returns the decoded result. The command
parses its arguments, calls the function and prints the result. The contract's
handler calls the same function. A handler holds no logic of its own.

The move is one change per command module, with that module's tests unchanged,
and it lands before the handlers for that module.

## The UI server

`src/ui-server.ts` gives one Layer: the HTTP router, the contract's handlers on
a WebSocket route (`RpcServer.layerProtocolWebsocket`, JSON serialization), and
the page's files. `foreman serve` provides it beside `supervise`.

- **Readings that live as long as serve.** `supervise` builds a new dispatcher
  after each failure, and each dispatcher has its own `state`. So serve makes a
  `SubscriptionRef<Published>` that lives as long as the process. `supervise`
  writes each reading and each published failure to it. The `state.json`
  writer and the `Readings` stream both read from that ref. A dispatcher
  failure leaves the page connected and shows the failure as the reading's
  state.
- **The page is built when serve starts.** The Layer runs `Bun.build` on
  `packages/foreman-ui/src/main.tsx` (a path relative to foreman's own
  checkout) for the browser target, and serves the outputs from memory. serve
  exits after each new commit on foreman's checkout, and its service starts it
  again, so the page always matches the code that serves it. No built files are
  committed. A build that fails is logged and stops the UI server only: the
  dispatcher runs on.
- **Listens on this machine only.** The server listens on `127.0.0.1`. The
  port is `FOREMAN_UI_PORT`, read through `Config`, with a default of `7341`.
  Another device reaches it only through a proxy on this machine, such as
  `tailscale serve`.
- **Origin and Host checks.** Any web page open in the operator's browser can
  open a WebSocket to `localhost`. DNS rebinding lets a page on another domain
  reach `127.0.0.1` with that domain's name. This server dispatches agents,
  changes the policy and lands code. So the server refuses each request and
  each WebSocket upgrade that its **gate** does not admit. The gate is a set
  of `Host` values and a list of page origins. A request is admitted when its
  `Host` is in the set and its `Origin` is absent or in the list. The refusal
  is 403 with no body. The Layer takes the gate as an input. `foreman serve`
  passes `serveGate`: `127.0.0.1:<port>` and `localhost:<port>` over http, and
  each name in `FOREMAN_UI_HOSTS` over https. That setting is a comma-separated
  list of names written exactly as the browser sends them in `Host`
  (`box.tailnet.ts.net`, or `box.tailnet.ts.net:8443` off port 443). It is
  empty by default. An extra name is https only, because `tailscale serve`
  serves only https. The page tests pass the origin of vitest's browser page,
  which serves the page under test. The check runs on every request in both
  cases.
- **Reconnect.** When the WebSocket closes, the page shows that it is
  disconnected, tries again each second, and reloads itself when a new
  connection succeeds, so it runs the code of the new serve.
- **Stop closes open page sockets.** Bun's graceful `server.stop()` waits for
  open WebSockets forever, so Effect's BunHttpServer finalizer never finished
  with a page connected. The workspace patches `@effect/platform-bun@4.1.2` so
  that finalizer calls `server.stop(true)`. Closing the UI server Layer
  finishes with a page still open and closes that page's socket. The serve
  integration must close this Layer when the process stops.

## The page

- **One project per URL**: `/p/<project>`. `/` lists the projects in the
  readings. The page has no other state of its own besides what the operator is
  in the middle of (a drag, an open inspector).
- **Pipeline editor first.** The page begins with the pipeline editor, the
  reason for the move. It follows the prototype's wires view (branch
  `prototype/stack-or-wires`, and the free-form drawing task, which stores block
  positions in the pipelines file). Each drag lists the drawings its drop can
  give, as `PipelineChange` values. The page checks each one with `problemsOf`
  on the expansion, in the browser, and colours the preview green when it has no
  problem and amber with the count when it has some. On drop the page sends
  that change through `PipelineEdit`. The page draws the newest view the server
  sent, a `Pipeline` stream frame or an edit's answer, with the edits it has not
  answered replayed over it. It sends those edits one at a time, in drop order,
  so the replay matches what the server applies, and a refused edit drops the
  edits after it. The checks use the
  composites and offers the `Pipeline` stream carries, the ones the server
  checks with. The toolbar's Save and Discard send `PipelineSave` and
  `PipelineDiscard`; Save is disabled while the drawing has problems.
- **The other views** follow as the operator decides which features move:
  Tasks board, Models board, simulate, fleet, task detail.
- **Shared code.** The page imports the contract and foreman's pure modules
  (`problemsOf`, `expand`, `beltOf`, `layoutOf`, `PipelineChange`) directly, in
  place of the copies a mod needs. Schemas and pure rules live in `src/policy.ts`
  and `src/fleet.ts` with no I/O; readers and writers are `src/policy-file.ts`
  and path helpers in `src/paths.ts`. The page's build fails on any `node:`
  or `bun:` import, or on a browser polyfill warning.
- **Notifications.** A row that newly appears under Landed posts a browser
  notification, as the pane does. The page asks for the permission once.
- **Theme.** The page follows the browser's light or dark setting, with colour
  tokens in CSS.
- **Phones.** The page fits a phone's width with no sideways page scroll. The
  pipeline lays out `down` while the viewport is taller than it is wide, else
  `across`, as the pane does. The `Pipeline` stream and each `PipelineEdit`
  send the same flow, and each editor frame carries the flow it was laid out
  in. The canvas is as wide as its container, or as the drawing when the
  drawing is wider. dragology sets `touch-action: none` on its whole SVG; the
  page overrides it to `pan-x pan-y`, so a finger on the drawing scrolls, and
  keeps `none` on the exit handles, so a finger on a handle drags. On a touch
  screen the handles and the toolbar buttons are larger. A browser test at a
  390 by 844 viewport checks the width, the touch-action values and that a
  touch drag sends one `PipelineEdit` with `flow: "down"`. The other browser
  tests run at 1280 by 800.

## Tests

No test runs `foreman serve`, so the trap in `AGENTS.md` ("Do not run `foreman
serve` to check that it starts") stays as it is.

- **Verbs**: the existing command tests, run on the moved functions.
- **Contract**: the handlers run with `RpcTest` against a temporary
  `XDG_CONFIG_HOME` and a temporary store, as `src/composite-command.test.ts`
  does. A fake `Fleet` answers dispatch, intervene and approve. A test fills the
  readings ref with fixed readings.
- **Origin**: a WebSocket upgrade with a foreign `Origin`, and a request with a
  foreign `Host`, each get 403.
- **Page**: vitest Browser Mode with the Playwright provider
  (`@vitest/browser-playwright`) and headless Chromium. The package's vitest
  config has two projects: `unit`, which runs on Bun, and `browser`, which
  renders the page's React views in Chromium. A browser command runs on Bun
  and the page calls it with its own `location.origin`. It starts the UI server
  with the fixtures above in a child process on a free port, trusting that one
  origin, and returns the port. The child process is stopped the way serve
  stops, so a disconnect test drops the page's real socket. The tests drive the views
  with real pointer events: a drag from an exit to a block gives the expected
  `PipelineEdit`, and an amber preview shows the problem count. These tests
  run in the gate. A missing Chromium fails the gate. It does not skip the
  tests.
- **Runner**: every test in the package runs with `bunx --bun vitest run` on
  `@effect/vitest`. On Node, vitest's workers cannot load `bun:` modules.
  `scripts/worktree-setup` installs the headless Chromium build that the
  pinned Playwright names. The browser cache is shared by every project on the
  machine, and another project's Playwright can replace that build. The gate
  itself does not download a browser.
- **A look by an agent**: `bun run dev` in `packages/foreman-ui` starts the
  same Layer with the same fixtures and prints its URL. An agent opens it with
  its browser tool. The operator is not needed to test the page.

`packages/foreman-ui/package.json` has its own `format:check`, `lint`,
`typecheck` and `test` scripts, so the root `bun run test` runs them.

## What it replaces, and conflicts

Each rule below is changed by this record. The record wins in each case.

| Rule | Where it stands | Change |
| --- | --- | --- |
| The pipeline editor moves to a herdr-app mod pane; herdr-web's pipeline page becomes read-only (Nov 2) | the pane-editor epic's description | The editor is built in the page. A note on that epic says so; the old text stays above it. |
| "UI library: foldkit" | the web UI epic's description | React 19 with dragology. |
| The pane is the front end. It reads `state.json` and runs `foreman` commands, "because a mod cannot load foreman's modules" | `AGENTS.md`, Front ends | The page imports foreman's modules and calls verbs through the contract. The section is rewritten when the page's first view lands. Until then it describes the frozen pane, which is still true. |
| Each reading is written to `state.json`, which the pane reads | `src/serve.ts`, its doc comment | Still true. Readings also reach the page through the `Readings` stream. |
| Do not run `foreman serve` to check that it starts | `AGENTS.md`, Traps | No change: the tests start the UI server Layer, never serve. |
| Durable state beyond the policy, pipelines, drafts and instructions files is a wall | `AGENTS.md`, "The world holds the work" | No conflict: the port is an environment setting, and the page stores nothing. |
| `effect` and `@effect/platform-bun` are pinned to 4.1.0 | `packages/foreman/package.json` | 4.1.2, for `@effect/atom-react`. |
| An `Origin` other than `http://127.0.0.1:<port>` or `http://localhost:<port>` is refused | this record, before vitest Browser Mode | The Layer takes the trusted page origin as an input; serve passes its own address. |
| The server answers only requests that name `127.0.0.1:<port>` or `localhost:<port>` | this record, before `FOREMAN_UI_HOSTS` | The gate also admits each name in `FOREMAN_UI_HOSTS`, from its https origin, so a phone reaches the page through `tailscale serve`. The listen address stays `127.0.0.1`. |
| The Playwright version matches the Chromium that is installed, so the gate does not download a browser | this record, Tests, Runner | `scripts/worktree-setup` installs the Chromium build the pinned Playwright names; the gate still downloads nothing. |
| The page tests are plain Playwright | this record, before vitest Browser Mode | vitest Browser Mode with the Playwright provider, in the same vitest run as the unit tests. |
| Tests use `bun:test` | every package's `test:unit` script | `packages/foreman-ui` uses `@effect/vitest` on Bun. foreman and tasks move later, in their own task. |

## Checks

- With serve's dispatcher failing on purpose in a test, the readings ref
  receives the failure, and a connected `Readings` client receives it without
  a reconnect.
- A `PipelineEdit` sent through the contract and the same change sent through
  `foreman pipeline edit` leave the same drafts file.
- A bundle of the page has no `node:` or `bun:` import.
- An upgrade from `Origin: http://example.com` is refused.
- With `FOREMAN_UI_HOSTS=box.tailnet.ts.net`, a request with that `Host` and
  `Origin: https://box.tailnet.ts.net` is admitted, and one with `Host:
  evil.example` from its own origin is refused.
- A drag in the editor that would leave a block unreachable shows an amber
  preview with one problem, and a drop sends exactly one `PipelineEdit`.
