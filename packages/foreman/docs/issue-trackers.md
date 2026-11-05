# Issue trackers: tasks, GitHub issues and Linear; landing by pull request

A project keeps its task list in one of three trackers: `tasks` (the default),
GitHub issues, or Linear. foreman reads and changes GitHub issues with the
`gh` CLI and Linear issues with Linear's GraphQL API. foreman keeps its own
records (runs, charges, parks) in the tasks store's tables for every tracker.
A project whose checkout is on GitHub can land a task by opening a pull request
and merging it on GitHub.

## Terms

- **Tracker**: where a project's task list lives: `tasks`, `github` or
  `linear`.
- **GitHub project**: a project whose tracker is GitHub. A **Linear project**
  has Linear as its tracker. Every other project is a **tasks project**.
- **Repo**: the GitHub repository of a GitHub project, `OWNER/NAME`, read from
  the checkout with `gh repo view --json nameWithOwner` (run in the checkout, it
  resolves the `origin` remote). The repo is never stored.
- **PR landing**: a land block with `how: pull-request`.
- **Issue id**: the id foreman gives an issue: `<project>#<number>` for GitHub,
  for example `foreman#42`, and `<project>#<identifier>` for Linear, for
  example `foreman#ENG-42`.
- **Claim confirmation**: after `claim` writes, the tracker reads the issue
  again until the read shows the claim (section 1).

## 1. The tracker

`Tracker` (`src/tracker.ts`) is the whole tracker surface. Three adapters
implement it: `TasksTracker` (the `tasks` package's store), `githubTracker` in
`src/github-tracker.ts` (over `gh`), and `linearTracker` in
`src/linear-tracker.ts` (over Linear's GraphQL API, section 7). `ProjectTracker`
routes each call to the adapter of the task's project (section 6). Nothing above
`Tracker` runs `gh` for issues or calls Linear.

### The claim is confirmed before dispatch

`claim` answers only when a read of the issue shows the claim. GitHub's reads
can lag its writes, so a dispatch that trusts the write alone can start a second
worker on a task the next read still shows as open.

- `githubTracker` re-reads the issue each second through the REST endpoint
  `gh api repos/<repo>/issues/<n>`, through the ETag cache (section 5), until the
  issue has the `status` label `in_progress` and the `@me` assignee.
- `linearTracker` runs the same confirmation: it re-reads each second until the
  issue shows the started state and the viewer as assignee.
- `TasksTracker.claim` writes in one SQL transaction, so its write is its read.

Confirmation stops after 30 seconds with a `TrackerError`
(`confirm` in `src/github-tracker.ts`). The dispatch then does not start, and
the claim stays. The next tick's release of stale claims sees a claim with no
run of foreman's and reopens it.

### The issue as an `Item`

| `Item` field | From the issue |
|---|---|
| `id` | `<project>#<number>` |
| `project` | the project name (the checkout's folder name), not the repo |
| `type` | `epic` when the issue has sub-issues (`subIssuesSummary.total > 0`) or its issue type is named `Epic`; else `task` |
| `title` | `title` |
| `description` | `body`, less the definition-of-done section |
| `definitionOfDone` | the body's `## Definition of done` section, else `undefined` |
| `status` | see the status table |
| `priority` | the `priority` label with value `1`, `2` or `3`; `2` when absent |
| `parent` | the issue id of `parent`, when the parent is in the same repo; else `undefined` |
| `labels` | the issue's label names, less the `status` and `priority` labels |
| `createdAt`, `updatedAt` | the issue's own |
| `lastActivityAt` | the later of `updatedAt` and the newest comment |

### Status

GitHub has two issue states. Labels carry the rest. A label whose kind is
`status` holds the status, parsed by `kindOf` in `src/records.ts` like every
other label.

| `Status` | Issue |
|---|---|
| `proposed` | open, `status` label `proposed` |
| `draft` | open, `status` label `draft` |
| `open` | open, no `status` label, no assignee |
| `in_progress` | open, `status` label `in_progress` |
| `blocked` | derived, as in the tasks store: open with an open `blockedBy` issue |
| `done` | closed, `stateReason` `COMPLETED` |
| `canceled` | closed, `stateReason` `NOT_PLANNED` or `DUPLICATE` |

An open issue with an assignee and no `status` label is a claim made by a
person. It is not ready, and foreman does not treat it as its own. A claim made
by hand is its owner's.

### Method by method

A tick reads each project's issues with one GraphQL query (section 5).
`lookup` reads the issue from the snapshot when the tick holds it, else with a
GraphQL query for that one issue.

| Method | `gh` and GraphQL |
|---|---|
| `lookup(id)` | the tick's snapshot, else one GraphQL query for the issue. A missing issue answers `None`; any other failure is a `TrackerError`. |
| `list(filter)` | the project's snapshot, filtered in process by `status`, `parent`, `type`, `label`. |
| `dependencies(project)` | each issue's `blockedBy` nodes in the snapshot. An edge to an issue in another repo is kept, with that issue's state, and names it `OWNER/NAME#n`. |
| `ready(project)` | open issues with no `status` label, no assignee, type `task`, and no open `blockedBy`. `ready(undefined)` joins the ready issues of every GitHub project with the tasks store. |
| `logs(id)` | `gh issue view <n> -R <repo> --comments`: the issue's comments, oldest first. |
| `add(task)` | `gh issue create -R <repo> --title … --body-file - --label …`; answers `<project>#<number>` from the URL it prints. Each label the repo lacks is made first. |
| `claim(id)` | `gh issue edit <n> --add-label` for the `status` label `in_progress` and `--add-assignee @me`. On a closed issue, `gh issue reopen <n>` first. |
| `reopen(id)` | `gh issue reopen <n>` when closed; then removes every `status` label and the `@me` assignee. |
| `complete(id)` | `gh issue close <n> --reason completed`, then removes the `status` label. |
| `cancel(id)` | `gh issue close <n> --reason "not planned"`, then removes the `status` label. |
| `label`, `unlabel` | `gh issue edit <n> --add-label` / `--remove-label`. A label the repo lacks is made first with `gh label create <name> --force`. |
| `relabel(id, change)` | reads the labels, computes `change`, and writes the whole set in one call: `gh api -X PUT repos/<repo>/issues/<n>/labels`. Answers the labels it read. |
| `log(id, message)` | `gh issue comment <n> --body-file -`. |
| `refresh(project)` | the project's GraphQL read (section 5). The dispatcher calls it for each project at the start of a reading. The snapshot holds until the next refresh or a write in that project. A failed read holds the project as `unreachable`. The tasks adapter does nothing. |

Each move skips an issue that already has the status it leads to, as
`TasksTracker.move` does. A move that failed half way is finished by the next
one, so a retry is safe.

A GitHub issue's sub-issues and dependencies are set by the operator on GitHub.
foreman writes neither. `add` takes no parent and no blocker.

### Records first, then the tracker move

`Records` runs a records write and a status move in one SQL transaction
(`together` in `src/records.ts`). That transaction holds only while both run on
one store connection. A GitHub or Linear move is an HTTP call, and no
transaction spans it.

For a GitHub or Linear project, foreman writes the records first, then makes
the tracker move. Every pair has a safe half-way state, because placement reads
the runs, and each move is idempotent:

- **Release** (close runs, then reopen): a failed reopen leaves an
  `in_progress` issue with no open run of foreman's. The next tick's release of
  stale claims sees an author run of foreman's and reopens it.
- **Complete** (record `Landed`, then close): a failed close leaves a claimed
  task at its land block (or done block) with the approved exit on the tip. The
  next tick lands it again. A local merge answers `Present` because the checkout
  holds the branch. A PR reads `MERGED`, and the landing completes the task.
- **Claim at dispatch** (claim, then open the run): a claim with no run is the
  hand-made claim case.

`Records.layer` builds `Records` on the tasks store's connection and takes
`Tracker` from `ProjectTracker`. `together` keeps its transaction for the
records half only.

## 2. Records, ids and what the front ends show

Runs, charges and parks stay in the tasks store's tables. They record foreman's
work, not the task list, so they stay in the tasks store for every tracker.

- `runs.task`, `charges.task` and `parks.task` are `TEXT NOT NULL` with no
  foreign key to `items` (`node_modules/tasks/src/migrations.ts`), so an issue
  id fits as is.
- The id is unique across all projects, because `Tracker.lookup` takes only an
  id. `<project>#<number>` is unique: project names are unique among managed
  checkouts (two with one name are held `ambiguous`), and local task ids hold no
  `#`. The prefix before `#` is how `ProjectTracker` routes an id to its project.
- The branch is `foreman/<project>#<number>`. `git check-ref-format` accepts it.
  `#` starts a shell comment only at the start of a word, so the id needs no
  quotes in `foreman exit foreman#42 approved`.
- hc labels (`fm.task`) take the id as is.

The board and `state.json` (`src/published.ts`) show the issue id as the task
id. Each queued, claimed and reviewing row and placement also carries:

- `url`: the task's page from `Tracker.url`. A GitHub issue is
  `https://github.com/<repo>/issues/<n>`, a Linear issue is the `url` Linear
  answers, and a local task has none. `foreman queue --json` reads no tracker
  snapshot, so its rows carry `url: null`.
- At a PR landing: `pr` with `number`, `url`, `state` (`open`, `merged`,
  `closed`), `checks` (`pending`, `passing`, `failing`), and `waiting` (what the
  merge waits for: `checks`; `you` while a land gate asks; `github` while a land
  gate denies the merge). `waiting` comes from the plan's own land-gate decision
  (`FleetState.merging`), grants included, so a front end applies no policy rule
  of its own.

Each project in the reading carries `tracker` (`tasks`, `github` or `linear`),
`repo` when its checkout is on GitHub, whatever its tracker (the same
`checkoutRepo` read the PR landing makes), and `unreachable` for a GitHub or
Linear project (sections 5 and 7).

Agents read and write a task through foreman, never a tracker's own CLI:
`foreman show <id>`, `foreman log <id> -`, `foreman list -p <project>` and
`foreman add "<title>" -p <project> -d <text>` route through `ProjectTracker`.
An onboarding agent ends with `foreman exit <id> done`, like any author.

## 3. Landing by pull request

`LANDINGS` in `src/pipeline.ts` lists `merge`, `fast-forward` and
`pull-request`. The pipeline rules apply to every landing: a branch before the
land, a review after the last author, a gate before the land. A PR landing is
valid in any project, but it needs a GitHub repo (section 6). Validation of a
project with no repo names the block.

### Steps

A task reaches the land block with an `approved` exit on commit `C`.

1. **Publish.** `git push origin <C>:refs/heads/foreman/<id>`, then
   `gh pr create -R <repo> --head foreman/<id> --base <trunk> --title <title>
   --body <body>`. The body ends with `Closes #<n>` for an issue of the same
   repo, so GitHub closes the issue when the PR merges into the default branch.
   When an open PR for the head branch exists (`gh pr list --head
   foreman/<id> --state open`), foreman uses it and creates none. So a publish
   interrupted after the push repeats safely.
2. **Review.** foreman posts the review run's verdict as a PR review on `C`,
   with the reviewer's summary from the task's log as the body. The project's
   `review` setting chooses the kind (see "The reviewer cannot approve its own
   PR" below).
3. **Merge**, by the land step's mode (section 4). foreman merges with
   `gh pr merge <pr> --merge --match-head-commit <C>`. `--match-head-commit`
   makes GitHub refuse the merge when the PR head is not `C`, so what lands is
   what the reviewer read. `--merge` makes a merge commit. foreman never squashes
   or rebases, because both make a commit the reviewer did not read.
4. **Complete.** When the PR reads `MERGED`, foreman records `Landed`, closes
   the issue when GitHub did not (a trunk that is not the default branch does
   not close it), removes the worktree, and deletes the local branch. GitHub
   deletes the remote branch when the repo is set to.

No PR is stored. foreman finds it each tick by its head branch, the same way it
finds the worktree by the branch.

### Where the work stands while the PR is open

The PR is the record of this step, as git is the record of the branch:

| PR reads | The task |
|---|---|
| no PR for the branch | at the land block, waiting to publish |
| open, head `C`, checks pending | at the land block, waiting for checks |
| open, head `C`, checks pass, `mergeStateStatus` `CLEAN` | at the land block, ready to merge by its mode |
| open, `mergeStateStatus` `DIRTY` (conflict) | returns to the queue at the same rung: record `Conflicted`, as a local conflict does |
| open, a required check failed on `C` | returns a rung up: record `Broke`, with `gh pr checks <pr> --required` output in the log |
| open, head is not `C` | the tip moved. The tip of a PR landing is the PR's `headRefOid`, so the approval is void and placement puts the task at the review again. foreman fetches the head into `foreman/<id>` before it dispatches the reviewer. |
| `MERGED` | done (step 4) |
| `CLOSED`, not merged | the project's `closed` setting decides: see "A PR closed without a merge" |

The local proving ground does not run for a PR landing. The repo's required
checks are the verification. foreman reads only the required checks. A repo with
none merges on review alone, and the task log says so.

### The reviewer cannot approve its own PR

GitHub refuses an approving review from the PR's author. foreman's reviewer and
the PR's author are the same `gh` account. The project's
`pullRequest.review` policy setting picks one of two kinds:

- `comment` (the default): foreman posts the verdict as a comment review
  (`gh pr review --comment`) with the one `gh` account. It records the verdict
  and approves nothing. A branch protection rule that needs an approval then
  needs the operator's.
- `approve`: foreman posts an approving review (`gh pr review --approve`) with a
  second credential, a bot account's token or a GitHub App token. The policy
  names where the credential is, as an environment variable name
  (`reviewTokenEnv`). foreman runs that one `gh pr review` call with `GH_TOKEN`
  set from it, and stores no token. A project set to `approve` whose variable
  is unset reads as unreachable with that reason, as a missing `gh auth login`
  does.

`comment` is the default because it needs no second credential.

### A PR closed without a merge

The operator closed the PR on GitHub. The project's `pullRequest.closed` setting
chooses the step:

- `park` (the default): park the task with the reason "PR closed without a
  merge". A closed PR is a decision a person made, like `canceled`.
- `requeue`: return the task to the queue at the same rung, as a conflict does.
  The next author cuts a new branch, and its publish opens a new PR, because
  publish reuses only an open PR.
- `cancel`: cancel the issue (close it as not planned) and record nothing more.

The setting applies to a closed PR whose head is the commit the current lap
approved. A closed PR from an earlier lap has another head and is passed over.
The record that the setting was applied is the run it writes (a park, a
requeue's new author run, or the canceled status), so no extra state is kept.

## 4. Two policy steps: `publish` opens the PR, `land` merges it

`STEPS` in `src/policy.ts` is `author`, `climb`, `review`, `publish`, `land`.
Opening a PR is its own policy step, `publish`, with `on`, `ask` and `off` like
the other gated steps. A grant, an approval and a project's own mode work for
`publish` as for every other step.

In every mode the task completes when the PR merges.

| Step | `on` | `ask` | `off` |
|---|---|---|---|
| `publish` | foreman pushes and opens the PR | the task waits in Needs you as an ask for `publish`; `foreman approve <id>` grants it | foreman opens no PR; the task waits at the land block |
| `land` | foreman merges when the review is posted and the required checks pass | the task waits in Needs you as an ask for `land`; `foreman approve <id>` grants it, then foreman merges as in `on` | foreman does not merge; the operator merges on GitHub, and foreman completes the task when it reads `MERGED` |

A PR landing therefore has two gates: the `publish` gate before step 1 and the
`land` gate before step 3. The review post (step 2) runs after publish with no
step of its own, because it writes only to the PR that publish opened. A local
landing keeps its one `land` gate.

Publish spends no model. It is still visible outside this machine (a push and a
PR), so it has a step the operator can stop. This follows the rule in
`docs/pipeline-engine.md`: a step that spends without a policy step would be one
the operator cannot stop.

A paused fleet or project still reads PR state and publishes it in the reading,
and writes nothing: it neither pushes, opens, merges nor completes.

## 5. Reading GitHub

### One read per project per tick

The tick reads each GitHub project once, with one `gh api graphql` query:

- open issues (first 100, by `updatedAt`, with `after:` cursors past 100), each
  with labels, assignees, `parent`, `subIssuesSummary`, `issueType`, `blockedBy`
  (first 20, with state), and the newest comment time;
- the issues foreman holds runs on that are closed (by number, `issue(number:)`
  aliases), so a task closed on GitHub reads as closed;
- `rateLimit { remaining limit resetAt }`, for the budget check below.

Comments (`logs`) are read only when a caller asks for one task's log.

PRs are not in that query. A PR is read by its head branch with
`gh pr list --head foreman/<id>`, which reports `number`, `url`, `state`,
`headRefOid`, `mergeStateStatus` and `reviews`. Required checks are read with
`gh pr checks <pr> --required`.

### Cost

GraphQL counts points per query, about 1 for a query of this size, out of 5000
an hour (`gh api rate_limit`). At the default `pollSeconds` of 20, one project
costs about 180 points an hour. Writes (`gh issue edit`, `comment`, `pr create`,
`pr merge`) count against the REST limit, also 5000 an hour, and come only from
foreman's own steps.

foreman reads the remaining points from the response. Below 10% left, it reads
GitHub projects only on every fifth tick until `resetAt`. A spent limit reads as
unreachable.

### REST reads use an ETag cache

A REST GET that repeats (the claim confirmation of section 1, the label read of
`relabel`, `gh pr checks`) goes through an ETag cache held in process. The cache
sends the cached `ETag` as `If-None-Match`, and on a `304 Not Modified` answers
the cached body. GitHub does not count a 304 against the REST limit, so a claim
confirmation that re-reads each second costs one request until the issue
changes.

The cache sits in `src/github.ts`, around its `gh api` runner:
`gh api -i -H 'If-None-Match: <etag>' <path>`, keyed by path, holding the `ETag`
header and body. The cache is process memory only. A restart starts it empty,
which costs one full read per path and changes no answer.

The tick's GraphQL read takes no cache, because GitHub gives GraphQL no ETag.

### Auth

foreman holds no token. Every call is `gh`, which uses the account set by
`gh auth login` (or `GH_TOKEN`). When the dispatcher's loop starts, it runs
`gh auth status`, which names a missing login once. Each GitHub project then
reads as unreachable with that reason. A one-shot command does not ask.

### When GitHub cannot be reached

A failed read is a `TrackerError`. It is not "no such issue": only a 404 from
`lookup` is.

- The project's tasks are absent from the reading for that tick. The project
  carries `unreachable` with the error, shown on the board as a held project is.
- The tick takes no step in that project: no dispatch, settle, publish, merge,
  release or sweep. Its workers keep running, and no worker reads as an orphan,
  because the tracker that would say "deleted" did not answer.
- Prog projects and other GitHub projects go on.
- A failed write is logged and repeats on the next tick. Every move is
  idempotent (section 1), so the repeat is safe.

## 6. Choosing a tracker, and where each part lives

### Where the choice lives

The tracker choice lives in foreman's policy file, `projects.<name>.tracker`,
one of `tasks`, `github` or `linear`. `foreman policy tracker <tasks|github|linear>
--project <name>` sets it. A project with no entry uses `tasks`. The policy holds
per-project operator intention, and the dispatcher reads it every pass.

The GitHub repo is always derived from the checkout (`gh repo view`), never
stored. A Linear project also names its Linear team and project (section 7),
and those are stored with the tracker choice, because nothing in the checkout
records them.

### Which issues agents take

Every issue can be worked, and the operator can limit the fleet to a selection.
The mechanism is the same for every tracker, so no filter label is added:

- With the `author` step `on`, every ready task is eligible.
- With it `off`, only granted tasks run. A grant covers one task or every task
  under an epic (`foreman policy grant`, or a drag on the board). For GitHub an
  epic is an issue with sub-issues. For Linear, an epic is an issue with children
  (sections 1 and 7).

### Project settings decide, labels do not

No per-issue label chooses the model or the land mode. The ladder chooses the
model, and the project's pipeline and policy choose the landing. foreman reads
only the `status` and `priority` labels on a GitHub issue, and no label on a
Linear issue.

### What agents are told

An agent reads and logs a task through foreman, not through the tracker's own
tool: `foreman show <id>` and `foreman log <id> -`, both through
`ProjectTracker`. One prompt then serves every tracker, the agent needs no
Linear or GitHub credential, and `src/prompt.ts` and `prompts/*.md` name no
tracker CLI.

### Modules

| Module | Owns |
|---|---|
| `src/tracker.ts` | `Tracker`, `TasksTracker` and `ProjectTracker`, which routes by the id's project prefix (`ready`, `list`, `dependencies` by the project argument) |
| `src/github-tracker.ts` | the GitHub adapter (section 1) and its one-read snapshot (section 5) |
| `src/github.ts` | the `gh` runner, the ETag cache, PR reads and writes (`gh pr create`, `list`, `review`, `merge`, `checks`); nothing above it runs `gh pr` |
| `src/pull-request-landing.ts` | the PR landing steps (section 3) |
| `src/linear-tracker.ts`, `src/linear-auth.ts`, `src/linear.ts` | the Linear adapter, its login and token, and its HTTP client (section 7) |
| `src/records.ts` | `layer` takes `Tracker` from `ProjectTracker`; `together` holds the records half of a transaction |
| `src/repository.ts` | `push` (a commit to a remote branch) and `fetchBranch` (the PR head into the task branch) |
| `src/pipeline.ts` | `LANDINGS`, and the validation of a PR landing: a `publish` gate and a `land` gate, and a GitHub repo |
| `src/policy.ts`, `src/policy-command.ts` | `STEPS`, `projects.<name>.tracker`, the Linear team and project, and `pullRequest` (`review`, `reviewTokenEnv`, `closed`); the `policy tracker` and `policy pull-request` commands |
| `src/dispatcher.ts` | `land` branches on `how: pull-request` to publish, read the PR and merge; a project whose tracker did not answer takes no step |
| `src/prompt.ts`, `prompts/*.md` | `foreman show` and `foreman log` |
| `src/store-commands.ts` | `foreman show`, `foreman log <id> -` |
| `src/published.ts`, `src/view.ts` | `url`, `pr`, project `tracker`, `repo`, `unreachable` (section 2) |

## 7. Linear

A Linear project keeps its task list in one Linear project of one Linear team.
`LinearTracker` in `src/linear-tracker.ts` implements `Tracker` over Linear's
GraphQL API (`https://api.linear.app/graphql`), through the client in
`src/linear.ts`.

### Login

`foreman linear login` runs the OAuth authorization-code flow with PKCE. It
starts a local callback server, sends a SHA-256 challenge, requests the
`read,write` scope, and exchanges the code at
`https://api.linear.app/oauth/token`.

foreman uses its own Linear OAuth application. The operator registers it at
`https://linear.app/settings/api/applications/new` with the callback URL
`http://localhost:34338/callback`, and sets `FOREMAN_LINEAR_CLIENT_ID` to its
client id. With neither that nor `LINEAR_API_KEY` set, `foreman linear login`
fails with these steps.

- The token, refresh token and expiry are written to
  `~/.config/foreman/linear-token.json`, mode `0600`, through a temporary file
  and a rename.
- A token is refreshed 30 minutes before it expires, with the `refresh_token`
  grant. The refresh sends the client id too, so it also needs
  `FOREMAN_LINEAR_CLIENT_ID`.
- Only Linear's refusal of the refresh token (a 4xx answer, for example
  `invalid_grant`) removes the token. A network error, a 5xx or no answer in 30
  seconds keeps the token file and fails the read. The project reads unreachable,
  and the next tick tries again.
- One lock holds every token read and refresh, so two calls in one tick refresh
  once.
- `LINEAR_API_KEY`, when set, is used instead, with no refresh.
- With no token, the dispatcher does not start the browser flow, because the
  flow waits for a person. Every Linear project reads as unreachable with the
  reason "run `foreman linear login`".

### Which team and project

`foreman policy tracker linear --project <name> --team <key>
--linear-project <name>` stores both (section 6). The command checks both names
against Linear when it writes them, and refuses a name Linear does not know. The
dispatcher has no person to ask, so the check runs at write time.

### The issue as an `Item`

| `Item` field | From the issue |
|---|---|
| `id` | `<project>#<identifier>`, for example `foreman#ENG-42` |
| `type` | `epic` when the issue has children; else `task` |
| `title`, `description` | `title`; `description` less the definition-of-done section |
| `definitionOfDone` | the description's `## Definition of done` section |
| `status` | the state table below |
| `priority` | Linear `1` (urgent) and `2` (high) → `1`; `3` (medium) and `0` (none) → `2`; `4` (low) → `3` |
| `parent` | `<project>#<parent.identifier>` when the parent is in the same Linear project |
| `labels` | the issue's label names |
| `createdAt`, `updatedAt`, `lastActivityAt` | the issue's own; the newest comment for the last |

The branch is `foreman/<project>#ENG-42`, which `git check-ref-format` accepts.

### Workflow states, mapped by type

A Linear team defines its own workflow states, each with a `type`: `triage`,
`backlog`, `unstarted`, `started`, `completed` or `canceled`. foreman finds the
state for each status by type. Where a type holds several states, the name
decides: `Todo` for `unstarted`, and a name containing `progress` for `started`.
Team states come first.

| `Status` | Linear state |
|---|---|
| `proposed` | type `triage` |
| `draft` | type `backlog` |
| `open` | type `unstarted` (name `Todo` first) |
| `in_progress` | type `started` (name containing `progress` first) |
| `blocked` | derived: open with an incomplete blocker |
| `done` | type `completed` |
| `canceled` | type `canceled` |

Reads map every state by its type, so a state with any name reads right.
Writes pick the state by the table. foreman moves issues only to the
`unstarted`, `started`, `completed` and `canceled` types. A team with no state
of one of those types reads as unreachable with that reason, because foreman
cannot make that move. A team with no `triage` or `backlog` state can still be
worked.

foreman does not move an issue to a state of another type, because a move to
the wrong state type is a status the operator did not mean.

### One read per tick, blockers inline

The tick reads each Linear project with one GraphQL query. Each issue carries its
`inverseRelations` of type `blocks`, with the blocker's identifier and state. A
blocker in another project is kept, with its state, as in section 1.

- **The read pages.** foreman reads `pageInfo { hasNextPage endCursor }` and
  pages with `after:` until `hasNextPage` is false.
- **Closed issues stay visible.** The read takes every issue of the project whose
  state type is not `completed` or `canceled`, with no assignee filter, so a claim
  by another person reads from the assignee. It also takes the issues a `lookup`
  found outside that list, by Linear's issue id, with an
  `issues(filter: { id: { in: [...] } })` field in the same query. So an issue
  closed on Linear reads as closed. The filter is used instead of one
  `issue(id:)` alias per issue, because Linear answers `issue(id:)` for an issue
  it does not have with an error that fails the whole query.

### Method by method

| Method | Linear |
|---|---|
| `lookup(id)` | `issue(id: "<identifier>")`; `null` answers `None`. |
| `list`, `dependencies`, `ready` | the tick's read, as for GitHub. `ready` takes `unstarted` tasks with no assignee and no incomplete blocker. |
| `logs(id)` | the issue's `comments`, oldest first. |
| `add(task)` | `issueCreate` with team, project, title, description and the `unstarted` state. |
| `claim(id)` | `issueUpdate` with the `started` state and the viewer as assignee, then the confirming read of section 1. |
| `reopen(id)` | `issueUpdate` with the `unstarted` state and no assignee. |
| `complete(id)` | `issueUpdate` with the `completed` state. |
| `cancel(id)` | `issueUpdate` with the `canceled` state. |
| `label`, `unlabel`, `relabel` | `issueUpdate` with `labelIds`; a label the team lacks is made with `issueLabelCreate`. |
| `log(id, message)` | `commentCreate`. |

Each move skips an issue already in its target state, so a retry is safe. The
records-first order of section 1 applies to Linear too.

### Cost and reach

Linear limits requests and query complexity per hour. foreman reads the
remaining budget from the response headers (`x-ratelimit-requests-remaining`,
`x-ratelimit-complexity-remaining`) and slows a project to every fifth tick below
10% left, as for GitHub. A failed read makes the project unreachable for the
tick, with the rules of "When GitHub cannot be reached" in section 5.

### How a Linear task lands

Linear has no pull requests. The land block decides, as in a tasks project:

- `how: merge` or `fast-forward`: the task lands locally in the proving ground
  and the operator's checkout. `complete` then moves the issue to `completed`.
- `how: pull-request`: valid when the checkout's `origin` is on GitHub
  (section 3). The PR body names the issue (`Closes ENG-42`), which Linear's
  GitHub integration links when the workspace has it. foreman does not depend on
  that link. It moves the issue to `completed` itself when it reads the PR
  `MERGED` (section 3, step 4).
