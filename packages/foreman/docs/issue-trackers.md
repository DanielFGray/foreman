| `lookup(id)` | the snapshot, else `issues` filtered by team key and number; no node answers `None`. |# Issue trackers: prog, GitHub issues and Linear; landing by pull request

Status: design, not built. The operator answered the open questions on
2026-11-03; each answer is stated below as `Decision (operator)`. A choice
the record's author made is marked `Decision (agent)`.

A project keeps its task list in one of three trackers: prog (the default),
GitHub issues, or Linear. foreman reads and changes GitHub issues with the
`gh` CLI and Linear issues with Linear's GraphQL API. It keeps its own records
(runs, charges, parks) in prog's tables for every tracker. Any project whose
checkout is on GitHub can land a task by opening a pull request and merging it
on GitHub.

## Terms

- **Tracker**: where a project's task list lives: `prog`, `github` or
  `linear`.
- **GitHub project**: a project whose tracker is GitHub. A **Linear project**
  has Linear as its tracker. Every other project is a **prog project**.
- **Repo**: the GitHub repository of a GitHub project, `OWNER/NAME`, read from
  the checkout with `gh repo view --json nameWithOwner` (run in the checkout, it
  resolves the `origin` remote).
- **PR landing**: a land block with `how: pull-request`.
- **Issue id**: the id foreman gives an issue: `<project>#<number>` for GitHub,
  for example `foreman#42`, and `<project>#<identifier>` for Linear, for
  example `foreman#ENG-42`.
- **Claim confirmation**: after `claim` writes, the tracker reads the issue
  again until the read shows the claim (section 1).

## 1. The tracker: `GithubTracker`

`Tracker` (`src/tracker.ts`) stays the whole tracker surface. A second adapter,
`GithubTracker` in `src/github-tracker.ts`, implements it over `gh`. A third,
`LinearTracker`, is section 7. A routing layer, `ProjectTracker`, sends each
call to the adapter of the task's project (section 6). Nothing above `Tracker`
runs `gh` for issues or calls Linear.

### The claim is confirmed before dispatch

Decision (operator, from lalph): `claim` answers only when a read of the issue
shows the claim. lalph's GitHub source does this in `ensureInProgress`: it
re-reads the issue each second until the `in-progress` label shows
(`~/sources/lalph/src/Github.ts:732-750`). GitHub's reads can lag its writes,
so a dispatch that trusts the write alone can start a second worker on a task
the next read still shows as open.

The rule is part of the `Tracker` contract, so every adapter keeps it:

- `GithubTracker.claim` re-reads with `gh api repos/<repo>/issues/<n>` (a REST
  read through the ETag cache, section 5) each second until the issue has
  `status:in_progress` and the `@me` assignee.
- `LinearTracker.claim` re-reads once. lalph makes this a no-op because
  "linear api writes are reflected immediately in reads"
  (`~/sources/lalph/src/Linear.ts:566-567`); one read costs little and keeps
  the contract the same for every tracker.
- `TasksTracker.claim` writes in one SQL transaction, so its write is its
  read.

Confirmation stops after 30 seconds with a `TrackerError`. The dispatch then
does not start, and the claim stays: the next tick's release of stale claims
sees a claim with no run of foreman's and reopens it.

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
| `priority` | label `priority:1`, `priority:2` or `priority:3`; `2` when absent |
| `parent` | the issue id of `parent`, when the parent is in the same repo; else `undefined` |
| `labels` | the issue's label names, less the `status:*` and `priority:*` labels |
| `createdAt`, `updatedAt` | the issue's own |
| `lastActivityAt` | the later of `updatedAt` and the newest comment |

### Status

GitHub has two issue states. Labels carry the rest. The label kind is `status`,
so `kindOf` in `src/records.ts` parses it like every other label.

| `Status` | Issue |
|---|---|
| `proposed` | open, label `status:proposed` |
| `draft` | open, label `status:draft` |
| `open` | open, no `status:*` label, no assignee |
| `in_progress` | open, label `status:in_progress` |
| `blocked` | derived, as in prog: open with an open `blockedBy` issue |
| `done` | closed, `stateReason` `COMPLETED` |
| `canceled` | closed, `stateReason` `NOT_PLANNED` or `DUPLICATE` |

An open issue with an assignee and no `status:*` label is a claim made by a
person. It is not ready, and foreman does not treat it as its own: the rule
"a claim made by hand is its owner's" already covers it.

### Method by method

All reads of one project come from one GraphQL query per tick (section 5).
`lookup` of a single id outside a tick runs `gh issue view`.

| Method | `gh` |
|---|---|
| `lookup(id)` | `gh issue view <n> -R <repo> --json number,title,body,state,stateReason,labels,assignees,createdAt,updatedAt,comments` plus a GraphQL read of `parent`, `subIssuesSummary` and `issueType`. A 404 answers `None`; any other failure is a `TrackerError`. |
| `list(filter)` | the project's GraphQL read, filtered in process by `status`, `parent`, `type`, `label`. |
| `dependencies(project)` | each issue's `blockedBy` nodes in the same read. An edge to an issue in another repo is kept, with that issue's state, and names it `OWNER/NAME#n`. |
| `ready(project)` | open issues with no `status:*` label, no assignee, type `task`, and no open `blockedBy`. `ready(undefined)` joins the ready issues of every GitHub project with prog's. |
| `logs(id)` | the issue's comments, oldest first: author, time, body. |
| `add(task)` | `gh issue create -R <repo> --title … --body … --label …`; answers `<project>#<number>` from the URL it prints. |
| `claim(id)` | adds `status:in_progress` and assigns `@me`: `gh issue edit <n> --add-label status:in_progress --add-assignee @me`. On a closed issue, first `gh issue reopen <n>`. |
| `reopen(id)` | `gh issue reopen <n>` when closed; then removes every `status:*` label and the `@me` assignee. |
| `complete(id)` | `gh issue close <n> --reason completed`, then removes `status:*`. |
| `cancel(id)` | `gh issue close <n> --reason "not planned"`, then removes `status:*`. |
| `label`, `unlabel` | `gh issue edit <n> --add-label` / `--remove-label`. A label the repo lacks is made first with `gh label create <name> --force`. |
| `relabel(id, change)` | reads the labels, computes `change`, and writes the whole set in one call: `gh api -X PUT repos/<repo>/issues/<n>/labels` with `labels[]`. Answers the labels it read. |
| `log(id, message)` | `gh issue comment <n> --body-file -`. |
| `refresh(project)` | the project's GraphQL read (section 5). The dispatcher calls it for each project at the start of a reading; the snapshot holds until the next refresh or a write in that project, and a failure holds the project as `unreachable`. prog's adapter does nothing. |

Each move skips an issue that already has the status it leads to, as
`TasksTracker.move` does. So a move that failed half way is finished by the
next one, and a retry is safe.

The operator files sub-issues and dependencies on GitHub. foreman writes
neither, because `Tracker` has no method that makes an edge. The GraphQL
mutations exist (`addSubIssue`, `addBlockedBy`) for a later `add` that takes a
parent.

### The atomic write is gone

`Records` runs a records write and a status move in one SQL transaction
(`together` in `src/records.ts`). That holds only while both run on one store
connection. A GitHub move is an HTTP call, and no transaction spans it.

Rule for a GitHub project: write the records first, then the tracker move.
Every pair has a safe half-way state, because placement reads the runs, and
each move is idempotent:

- **Release** (close runs, then reopen): a failed reopen leaves an
  `in_progress` issue with no open run of foreman's. The next tick's release of
  stale claims sees an author run of foreman's and reopens it.
- **Complete** (record `Landed`, then close): a failed close leaves a claimed
  task at its land block (or done block) with the approved exit on the tip. The
  next tick lands it again: a local merge answers Present because the checkout
  holds the branch, a PR reads `MERGED`, and the landing completes the task. No
  new settle rule is needed. A rule that completed any claimed task whose last
  author run landed would complete a done task that was claimed again before
  its next author run.
- **Claim at dispatch** (claim, then open the run): unchanged order; a claim
  with no run is the hand-made claim case.

`Records.layer` then builds `Records` on the prog store's connection and takes
`Tracker` from `ProjectTracker`. `together` keeps its transaction for the
records half only.

## 2. Records, ids and what the front ends show

Runs, charges and parks stay in prog's tables. They record foreman's work, not
the task list, so they do not move to GitHub.

- `runs.task`, `charges.task` and `parks.task` are `TEXT NOT NULL` with no
  foreign key to `items` (`node_modules/tasks/src/migrations.ts`), so an issue
  id fits as is.
- The id must be unique across all projects, because `Tracker.lookup` takes
  only an id. `<project>#<number>` is unique: project names are unique among
  managed checkouts (two with one name are held `ambiguous`), and prog ids
  (`ts-…`, `ep-…`) hold no `#`. The prefix before `#` is also how
  `ProjectTracker` routes an id to its project.
- The branch is `foreman/<project>#<number>`. `git check-ref-format` accepts
  it. `#` starts a shell comment only at the start of a word, so the id needs
  no quotes in `foreman exit foreman#42 approved`.
- hc labels (`fm.task`) take the id as is.

The board and `state.json` (`src/published.ts`) show the issue id as the task
id. Each queued, claimed and reviewing row and placement also carries:

- `url`: the task's page from `Tracker.url`. A GitHub issue is
  `https://github.com/<repo>/issues/<n>`, a Linear issue is the `url` Linear
  answers, and a prog task has none. `foreman queue --json` reads no tracker
  snapshot, so its rows carry `url: null`.
- At a PR landing: `pr` with `number`, `url`, `state` (`open`, `merged`,
  `closed`), `checks` (`pending`, `passing`, `failing`), and `waiting` (what
  the merge waits for: `checks`; `you` while a land gate asks; `github` while a
  land gate denies the merge). `waiting` comes from the plan's own land-gate
  decision (`FleetState.merging`), grants included, so a front end applies no
  policy rule of its own.

Each project in the reading carries `tracker` (`prog`, `github` or `linear`), `repo` when
its checkout is on GitHub, whatever its tracker (the same `checkoutRepo` read the
PR landing makes), and `unreachable` for a GitHub or Linear project
(sections 5 and 7).

Agents read and write a task through foreman, never a tracker's own CLI:
`foreman show <id>`, `foreman log <id> -`, `foreman list -p <project>` and
`foreman add "<title>" -p <project> -d <text>` route through `ProjectTracker`.
An onboarding agent ends with `foreman exit <id> done`, like any author.

## 3. Landing by pull request

`LANDINGS` in `src/pipeline.ts` gains `pull-request`:

```ts
export const LANDINGS = ["merge", "fast-forward", "pull-request"] as const;
```

The pipeline rules do not change: a branch before the land, a review after the
last author, a gate before the land. A PR landing is valid in any project, but
it needs a GitHub repo (section 6); validation of a project with no repo names
the block.

### Steps

A task reaches the land block with an `approved` exit on commit `C`, as today.

1. **Publish.** `git push origin <C>:refs/heads/foreman/<id>`. Then
   `gh pr create -R <repo> --head foreman/<id> --base <trunk> --title <title>
   --body <body>`. The body ends with `Closes #<n>` for an issue of the same
   repo, so GitHub closes the issue when the PR merges into the default branch.
   When an open PR for the head branch already exists (`gh pr list --head
   foreman/<id> --state open --json number,state`), foreman uses it and
   creates none. So a publish interrupted after the push repeats safely.
2. **Review.** foreman posts the review run's verdict as a PR review on `C`:
   the reviewer's summary from the task's log as the body. The project's
   `review` setting chooses the kind (see "The reviewer cannot approve its own
   PR" below).
3. **Merge**, by the land step's mode (section 4). foreman merges with
   `gh pr merge <pr> --merge --match-head-commit <C>`. `--match-head-commit`
   makes GitHub refuse the merge when the PR head is not `C`, so what lands is
   what the reviewer read. `--merge` makes a merge commit; foreman never
   squashes or rebases, because both make a commit the reviewer did not read.
4. **Complete.** When the PR reads `MERGED`, foreman records `Landed`, closes
   the issue when GitHub did not (a trunk that is not the default branch does
   not close it), removes the worktree, and deletes the local branch. GitHub
   deletes the remote branch when the repo is set to.

No PR is stored. foreman finds it each tick by its head branch, the same way
it finds the worktree by the branch.

### Where the work stands while the PR is open

The PR is the world's record for this step, as git is for the branch:

| PR reads | The task |
|---|---|
| no PR for the branch | at the land block, waiting to publish |
| open, head `C`, checks pending | at the land block, waiting for checks |
| open, head `C`, checks pass, `mergeStateStatus` `CLEAN` | at the land block, ready to merge by its mode |
| open, `mergeStateStatus` `DIRTY` (conflict) | returns to the queue at the same rung: record `Conflicted`, as a local conflict does |
| open, a required check failed on `C` | returns a rung up: record `Broke`, with `gh pr checks <pr> --required` output in the log |
| open, head is not `C` | the tip moved: the task's tip for a PR landing is the PR's `headRefOid`, so the approval is void and placement puts the task at the review again. foreman fetches the head into `foreman/<id>` before it dispatches the reviewer. |
| `MERGED` | done (step 4) |
| `CLOSED`, not merged | the project's `closedPullRequest` setting decides: see "A PR closed without a merge" |

The local proving ground does not run for a PR landing: the repo's required
checks are the verification. A check that fails says nothing about which side
broke it, so the "red before the merge" rule of the proving ground has no
GitHub equivalent. foreman reads only the required checks; a repo with none
merges on review alone, and the task log says so, as it does for a project with
no `scripts/verify.sh`.

### The reviewer cannot approve its own PR

GitHub refuses an approving review from the PR's author. foreman's reviewer
and the PR's author are the same `gh` account.

Decision (operator): both kinds are allowed, chosen per project by
`projects.<name>.pullRequest.review` in the policy file:

- `comment` (the default): foreman posts the verdict as a comment review
  (`gh pr review --comment`) with the one `gh` account. It records the verdict
  and approves nothing; a branch protection rule that needs an approval then
  needs the operator's.
- `approve`: foreman posts a real review (`--approve` or `--request-changes`)
  with a second credential, a bot account's token or a GitHub App token. The
  policy names where the credential is, as an environment variable name
  (`reviewTokenEnv`); foreman runs that one `gh pr review` call with
  `GH_TOKEN` set from it and stores no token. A project set to `approve` whose
  variable is unset reads as unreachable with that reason, as a missing
  `gh auth login` does.

Decision (agent): `comment` is the default because it needs no second
credential.

### A PR closed without a merge

The operator closed the PR on GitHub. Decision (operator): the project's
`projects.<name>.pullRequest.closed` setting chooses:

- `park` (the default): park the task with the reason "PR closed without a
  merge". A closed PR is a decision a person made, like `canceled`.
- `requeue`: return the task to the queue at the same rung, as a conflict
  does. The next author cuts a new branch, and its publish opens a new PR,
  because the closed one is passed over by `--state open` in step 1.
- `cancel`: cancel the issue (close it as not planned) and record nothing more.

Decision (agent): `park` is the default, so foreman takes no step after a
person's decision until the operator says which step.

Publish reuses an open PR only (step 1). The setting applies to a closed PR
whose head is the commit the current lap approved; a closed PR from an earlier
lap has another head and is passed over. The record
that it was applied is the run the setting writes (a park, a requeue's new
author run, or the canceled status), so no extra state is kept.

## 4. Two policy steps: `publish` opens the PR, `land` merges it

Decision (operator): opening a PR is its own policy step, `publish`, with
`on`, `ask` and `off` like the other gated steps. `STEPS` in `src/policy.ts`
becomes `author`, `climb`, `review`, `publish`, `land`. A grant, an approval
and a project's own mode work for `publish` as for every other step.

Decision (operator): in every mode the task completes when the PR merges.

| Step | `on` | `ask` | `off` |
|---|---|---|---|
| `publish` | foreman pushes and opens the PR | the task waits in Needs you as an ask for `publish`; `foreman approve <id>` grants it | foreman opens no PR; the task waits at the land block |
| `land` | foreman merges when the review is posted and the required checks pass | the task waits in Needs you as an ask for `land`; `foreman approve <id>` grants it, then foreman merges as in `on` | foreman does not merge; the operator merges on GitHub, and foreman completes the task when it reads `MERGED` |

A PR landing therefore has two gates: the `publish` gate before step 1 and the
`land` gate before step 3. The review post (step 2) runs after publish with no
step of its own, because it writes only to the PR that publish opened. A local
landing keeps its one `land` gate.

This keeps the earlier rule in `docs/pipeline-engine.md` ("A step that spends
without a policy step would be one the operator cannot stop"): publish spends
no model, but it is visible outside this machine (a push and a PR), and now
has a step the operator can stop.

A paused fleet or project still reads PR state and publishes it in the
reading, and writes nothing: it neither pushes, opens, merges nor completes.

## 5. Reading GitHub

### One read per project per tick

The tick reads each GitHub project once, with one `gh api graphql` query:

- open issues (first 100, by `updatedAt`), each with labels, assignees,
  `parent`, `subIssuesSummary`, `issueType`, `blockedBy` (first 20, with
  state), and the last comment time;
- the issues foreman holds runs on that are closed (by number, `issue(number:)`
  aliases), so a task closed on GitHub reads as closed;
- open and recently closed PRs whose head branch starts with `foreman/`, each
  with `number`, `state`, `headRefOid`, `mergeStateStatus`, `reviewDecision`,
  and `statusCheckRollup` of the head commit.

More than 100 open issues pages with `after:` cursors. Comments (`logs`) are
read only when a caller asks for one task's log.

### Cost

GraphQL counts points per query, about 1 for a query of this size, out of
5000 an hour (`gh api rate_limit`). At the default `pollSeconds` of 20, one
project costs 180 points an hour, so about 25 projects fit with room for writes.
Writes (`gh issue edit`, `comment`, `pr create`, `pr merge`) count against the
REST limit, also 5000 an hour, and come only from foreman's own steps.

foreman reads the remaining points in the response (`rateLimit { remaining
resetAt }` in the same query). Below 10% left, it reads GitHub projects only on
every fifth tick until `resetAt`. A spent limit reads as unreachable.

### REST reads use an ETag cache

Decision (operator, from lalph): a REST GET that remains (the claim
confirmation of section 1, the label read of `relabel`, `gh pr checks`) goes
through an ETag cache held in process. lalph wraps every GET of its Octokit
client: it sends the cached `etag` as `If-None-Match`, and on a
`304 Not Modified` answers the cached body (`~/sources/lalph/src/Github.ts:74-114`).
GitHub does not count a 304 against the REST limit, so a claim confirmation
that re-reads each second costs one request until the issue changes.

foreman calls `gh api`, not Octokit, so the cache sits in `src/github.ts`
around its `gh api` runner: `gh api -i -H 'If-None-Match: <etag>' <path>`,
keyed by method and path, holding the `ETag` header and body. The cache is
process memory only: a restart starts it empty, which costs one full read per
path and changes no answer.

The tick's GraphQL read takes no cache: GitHub gives GraphQL no ETag.

### Auth

foreman holds no token. Every call is `gh`, which uses the account
`gh auth login` set up (or `GH_TOKEN`). `gh auth status` when the dispatcher's loop starts names a
missing login once (a one-shot command does not ask), and each GitHub project then reads as unreachable with that
reason, like an unreadable quota account. `GH_HOST` selects GitHub Enterprise.

### When GitHub cannot be reached

A failed read is a `TrackerError`. It is not "no such issue": only a 404 from
`lookup` is.

- The project's tasks are absent from the reading for that tick, and the
  project carries `unreachable` with the error, shown on the board as a held
  project is.
- The tick takes no step in that project: no dispatch, settle, publish, merge,
  release or sweep. Its workers keep running, and no worker reads as an orphan,
  because the tracker that would say "deleted" did not answer.
- Prog projects and other GitHub projects go on.
- A failed write is logged and repeats on the next tick, which is safe because
  every move is idempotent (section 1).

## 6. Choosing a tracker, and what else changes

### Where the choice lives

Decision (operator): the tracker choice lives in foreman's policy file,
`projects.<name>.tracker`, one of `prog`, `github` or `linear`, set by
`foreman policy tracker <prog|github|linear> --project <name>`. A project with
no entry uses `prog`. The policy is where per-project operator intention
lives, and the dispatcher already reads it every pass.

The GitHub repo is always derived from the checkout (`gh repo view`), never
stored. A Linear project also names its Linear team and project (section 7),
and those are stored with the tracker choice, because nothing in the checkout
records them.

### Which issues agents take

Decision (operator): every issue can be worked, and the operator can limit the
fleet to a selection. Decision (coordinator): this is tracker-neutral and
already exists, so GitHub and Linear issues use the same mechanism as prog
tasks, and no filter label is added:

- With the `author` step `on`, every ready task is eligible.
- With it `off`, only granted tasks run. A grant covers one task or every task
  under an epic (`foreman policy grant`, or a drag on the board). For GitHub
  an epic is an issue with sub-issues; for Linear, an issue with children
  (sections 1 and 7).

### Project settings decide, labels do not

Decision (operator): no per-issue label chooses the model or the land mode.
The ladder chooses the model, and the project's pipeline and policy choose the
landing. foreman reads only `status:*` and `priority:*` labels on a GitHub
issue, and no label on a Linear issue.

### What agents are told

Decision (agent): an agent reads and logs a task through foreman, not the
tracker's own tool: `foreman show <id>` (it exists, `src/store-commands.ts`)
and a new `foreman log <id> -`, both through `ProjectTracker`. So one prompt
serves every tracker, the agent needs no Linear credential, and `src/prompt.ts`
and `prompts/*.md` name no tracker CLI. This replaces the record's earlier
plan to tell agents `gh issue view` and `gh issue comment`.

### What changes

| Part | Change |
|---|---|
| `src/tracker.ts` | `claim` is confirmed by a read (section 1). `ProjectTracker` routes by the id's project prefix (`ready`, `list`, `dependencies` by the project argument) to `TasksTracker`, `GithubTracker` or `LinearTracker`. |
| `src/github-tracker.ts` | new: the adapter of section 1 and the reading of section 5. |
| `src/linear-tracker.ts`, `src/linear-auth.ts` | new: section 7. |
| `src/records.ts` | `layer` takes `Tracker` from `ProjectTracker`; `together` keeps the records half; records first, then the move (section 1). |
| `src/dispatcher.ts` | `land` branches on `how: pull-request` to publish, read the PR, merge; the tip of a task at a PR landing is the PR head; a project whose tracker did not answer takes no step. |
| `src/repository.ts` | `push` (a commit to a remote branch) and `fetch` (the PR head into the task branch). |
| `src/github.ts` | new: PR reads and writes (`gh pr create`, `list`, `review`, `merge`, `checks`) and the ETag cache, beside `Repository` so nothing above it runs `gh pr`. |
| `src/pipeline.ts` | `LANDINGS` gains `pull-request`; a PR landing has a `publish` gate and a `land` gate; validation names a PR landing in a project with no GitHub repo. |
| `src/policy.ts` | `STEPS` gains `publish`; `projects.<name>.tracker`, the Linear team and project, and `pullRequest` (`review`, `reviewTokenEnv`, `closed`). |
| `src/policy-command.ts` | `foreman policy tracker` and `foreman policy pull-request`. |
| `src/prompt.ts`, `prompts/*.md` | `foreman show` and `foreman log` instead of `tasks show` and `tasks log`. |
| `src/store-commands.ts` | `foreman log <id> -`. |
| `src/published.ts`, `src/view.ts` | `url`, `pr`, project `tracker`, `repo`, `unreachable` (section 2). |
| herdr-app pane | the Foreman pane shows the same fields from `state.json`, and offers `pull-request` from `choices`, with no code of its own. |
| AGENTS.md | "Every task with a branch ends by merging into the project's main checkout" and "landing is the only code path that moves the operator's branch" hold for local landings only; a PR landing moves the remote trunk, and the operator's checkout takes it by its own pull. The policy steps list gains `publish`. |

## 7. Linear

A Linear project keeps its task list in one Linear project of one Linear team.
`LinearTracker` in `src/linear-tracker.ts` implements `Tracker` over Linear's
GraphQL API (`https://api.linear.app/graphql`). The design starts from lalph's
Linear source (`~/sources/lalph/src/Linear.ts`, `src/Linear/TokenManager.ts`,
`src/domain/LinearIssues.ts`) and fixes its gaps.

### Login

`foreman linear login` runs the OAuth authorization-code flow with PKCE, as
lalph's `TokenManager` does: a local callback server, a SHA-256 challenge, the
`read,write` scope, and a code exchange at `https://api.linear.app/oauth/token`
(`~/sources/lalph/src/Linear/TokenManager.ts:86-149`). foreman registers its
own Linear OAuth application; lalph's client id is lalph's. The operator
registers it at `https://linear.app/settings/api/applications/new` with the
callback URL `http://localhost:34338/callback`, and sets
`FOREMAN_LINEAR_CLIENT_ID` to its client id. With neither that nor
`LINEAR_API_KEY` set, `foreman linear login` fails with these steps.

- The token, refresh token and expiry are written to
  `~/.config/foreman/linear-token.json`, mode `0600`.
- A token is refreshed 30 minutes before it expires, with the
  `refresh_token` grant (`TokenManager.ts:151-164`, `192-198`). The refresh
  sends the client id too, so it also needs `FOREMAN_LINEAR_CLIENT_ID`.
- Only a 4xx answer to the refresh (for example `invalid_grant`) removes the
  token: Linear refused it. A network error, a 5xx or no answer in 30 seconds
  keeps the token file and fails the read, so the project reads unreachable
  and the next tick tries again.
- Every token read and refresh runs under one lock, as lalph's
  `Semaphore.withPermit` does (`TokenManager.ts:64-84`), so two calls in one
  tick do not refresh twice.
- `LINEAR_API_KEY`, when set, is used instead, with no refresh.
- With no token, the dispatcher does not start the browser flow: lalph opens
  it inside `get` (`TokenManager.ts:70-72`), which would stop a tick on a
  person. Every Linear project reads as unreachable with the reason "run
  `foreman linear login`".

### Which team and project

`foreman policy tracker linear --project <name> --team <key>
--linear-project <name>` stores both (section 6). lalph asks for them
interactively and caches them (`Linear.ts:191-205`); foreman's dispatcher has
no person to ask, so the command checks both names against Linear when it
writes them and refuses a name Linear does not know.

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

The branch is `foreman/<project>#ENG-42`, which `git check-ref-format`
accepts.

### Workflow states, mapped by name

A Linear team defines its own workflow states, each with a `type`
(`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`,
`~/sources/lalph/src/domain/LinearIssues.ts:3-10`). lalph finds the state for
each of its statuses by type, then by a name fragment, team states first
(`findState`, `Linear.ts:213-238`). foreman does the same:

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
`unstarted`, `started`, `completed` and `canceled` types, so a team with no state of one
of those reads as unreachable with that reason, because foreman cannot make
that move. A team with no `triage` or `backlog` state can still be worked.
lalph falls back to a state of another type (`Linear.ts:228`); foreman does
not, because a move to the wrong state type is a status the operator did not
mean.

### One read per tick, blockers inline

The tick reads each Linear project with one GraphQL query, as lalph's
`allIssuesQuery` does, with blockers inline: each issue's `inverseRelations`
of type `blocks`, with the blocker's identifier and state
(`Linear.ts:787-849`, `LinearIssues.ts:39-57`). A blocker in another project
is kept, with its state, as in section 1.

Two of lalph's gaps are fixed:

- **lalph reads at most 250 issues.** Its query asks for `first: 250` and
  reads no `pageInfo` (`Linear.ts:818-832`). foreman reads `pageInfo {
  hasNextPage endCursor }` and pages with `after:` until `hasNextPage` is
  false, as lalph's own `stream` helper does for other lists
  (`Linear.ts:76-90`).
- **lalph cannot see a closed issue it holds a run on.** Its filter takes only
  `unstarted`, `started` and `completed` issues assigned to the viewer
  (`Linear.ts:820-826`). foreman reads every issue of the project whose state
  type is not `completed` or `canceled`, with no assignee filter (a claim by
  another person is read from the assignee, as in section 1), and adds the
  issues a `lookup` found outside that list, by Linear's issue id, with an
  `issues(filter: { id: { in: [...] } })` field in the same query, so an
  issue closed on Linear reads as closed. A filter, not one `issue(id:)`
  alias per issue, because Linear answers `issue(id:)` for an issue it does
  not have with an error that fails the whole query.

### Method by method

| Method | Linear |
|---|---|
| `lookup(id)` | `issue(id: "<identifier>")`; `null` answers `None`. |
| `list`, `dependencies`, `ready` | the tick's read, as for GitHub. `ready` takes `unstarted` tasks with no assignee and no incomplete blocker. |
| `logs(id)` | the issue's `comments`, oldest first. |
| `add(task)` | `issueCreate` with team, project, title, description and the `unstarted` state. |
| `claim(id)` | `issueUpdate` with the `started` state and the viewer as assignee, then one confirming read (section 1). |
| `reopen(id)` | `issueUpdate` with the `unstarted` state and no assignee. |
| `complete(id)` | `issueUpdate` with the `completed` state. |
| `cancel(id)` | `issueUpdate` with the `canceled` state. |
| `label`, `unlabel`, `relabel` | `issueUpdate` with `labelIds`; a label the team lacks is made with `issueLabelCreate`. |
| `log(id, message)` | `commentCreate`. |

Each move skips an issue already in its target state, so a retry is safe. The
records-first order of section 1 holds for Linear too.

### Cost and reach

Linear limits requests and query complexity per hour. foreman reads the
remaining budget from the response headers (`X-RateLimit-Requests-Remaining`,
`X-RateLimit-Complexity-Remaining`) and slows a project to every fifth tick
below 10% left, as for GitHub. A failed read makes the project unreachable for
the tick, with the rules of "When GitHub cannot be reached" in section 5.

### How a Linear task lands

Linear has no pull requests. The land block decides, as in a prog project:

- `how: merge` or `fast-forward`: the task lands locally in the proving ground
  and the operator's checkout, then `complete` moves the issue to `completed`.
- `how: pull-request`: valid when the checkout's `origin` is on GitHub
  (section 3). The PR body names the issue (`Closes ENG-42`), which Linear's
  GitHub integration links when the workspace has it. foreman does not depend
  on that link: it moves the issue to `completed` itself when it reads the PR
  `MERGED` (section 3, step 4).

## Rules this changes

- `AGENTS.md`, Ports: "A records write that goes with a status move shares one
  transaction with it": holds for prog projects; a GitHub or Linear project
  writes the records first (section 1).
- `AGENTS.md`, Ports: "`TasksTracker` there is the one adapter": there are
  three, routed by `ProjectTracker`.
- `AGENTS.md`, the policy file paragraph and "Forking for your own workflow":
  the spending steps are `author`, `climb`, `review`, `publish`, `land`
  (section 4).
- `docs/pipeline-engine.md`, Validation: a PR landing has two gates,
  `publish` before the push and `land` before the merge (section 4).
- `AGENTS.md`, "A landing is proved somewhere disposable": a PR landing is
  proved by the repo's required checks, not the proving ground (section 3).
- `AGENTS.md`, "landing is the only code path that moves the operator's
  branch": a PR landing moves the remote trunk instead (section 6).
- `src/prompt.ts` and `prompts/author.md`: agents read and log with
  `foreman show` and `foreman log`, not `tasks show` and `tasks log`
  (section 6).
- `docs/workspace-blocks.md`, land block: `how` gains `pull-request`.
