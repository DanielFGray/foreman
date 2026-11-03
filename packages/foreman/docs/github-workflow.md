# GitHub projects: issues as the task list, landing by pull request

Status: design, not built. Open questions are filed under the epic as
`question` tasks; each section names the one it waits on.

A project can keep its task list in GitHub issues instead of prog. foreman then
reads and changes the issues with the `gh` CLI, keeps its own records (runs,
charges, parks) in prog's tables as before, and can land a task by opening a
pull request and merging it on GitHub.

## Terms

- **GitHub project**: a project whose tracker is GitHub. Every other project
  is a **prog project**.
- **Repo**: the GitHub repository of a GitHub project, `OWNER/NAME`, read from
  the checkout with `gh repo view --json nameWithOwner` (run in the checkout, it
  resolves the `origin` remote).
- **PR landing**: a land block with `how: pull-request`.
- **Issue id**: the id foreman gives an issue: `<project>#<number>`, for example
  `foreman#42`.

## 1. The tracker: `GithubTracker`

`Tracker` (`src/tracker.ts`) stays the whole tracker surface. A second adapter,
`GithubTracker` in `src/github-tracker.ts`, implements it over `gh`. A third
layer, `ProjectTracker`, routes each call to the adapter of the task's project
(section 6). Nothing above `Tracker` runs `gh` for issues.

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
| `label`, `unlabel` | `gh issue edit <n> --add-label` / `--remove-label`. A label the repo lacks is made first with `gh label create <name> --force`. |
| `relabel(id, change)` | reads the labels, computes `change`, and writes the whole set in one call: `gh api -X PUT repos/<repo>/issues/<n>/labels` with `labels[]`. Answers the labels it read. |
| `log(id, message)` | `gh issue comment <n> --body-file -`. |

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
- **Complete** (record `Landed`, then close): a failed close leaves an open
  issue whose last run landed. The next tick sees a `Landed` record on an open
  task and runs `complete` again. This needs one new rule in settle, written
  for every tracker, so it is not a GitHub path: a task whose latest run ended
  `Landed` and that is not `done` is completed.
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

The board, the queue and `state.json` (`src/published.ts`) show the issue id as
the task id. Each task row of a GitHub project also carries:

- `url`: `https://github.com/<repo>/issues/<n>`.
- At a PR landing: `pr` with `number`, `url`, `state` (`open`, `merged`,
  `closed`), `checks` (`pending`, `passing`, `failing`), and `waiting` (what
  the merge waits for: `checks`, `you` in `ask` mode, `github` in `off` mode).

Each project in the reading carries `tracker` (`prog` or `github`) and, for
GitHub, `repo` and `unreachable` (section 5).

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
   When a PR for the head branch already exists (`gh pr list --head
   foreman/<id> --state all --json number,state`), foreman uses it and creates
   none. So a publish interrupted after the push repeats safely.
2. **Review.** foreman posts the review run's verdict as a PR review on `C`:
   the reviewer's summary from the task's log as the body. The kind of review
   waits on a question (see "The reviewer cannot approve its own PR" below).
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
| `CLOSED`, not merged | waits on a question: see "A PR closed without a merge" |

The local proving ground does not run for a PR landing: the repo's required
checks are the verification. A check that fails says nothing about which side
broke it, so the "red before the merge" rule of the proving ground has no
GitHub equivalent. foreman reads only the required checks; a repo with none
merges on review alone, and the task log says so, as it does for a project with
no `scripts/verify.sh`.

### The reviewer cannot approve its own PR

GitHub refuses an approving review from the PR's author. foreman's reviewer
and the PR's author are the same `gh` account. Two options, filed as a
question:

- **A**: post the verdict as a comment review (`gh pr review --comment`). It
  records the verdict and approves nothing; a branch protection rule that needs
  an approval then needs the operator's.
- **B**: open the PR with one account and review with another (a bot account
  or a GitHub App token for the reviewer).

Recommendation: A, because it needs no second credential, and `ask` already
puts the operator's approval in the loop where it is wanted.

### A PR closed without a merge

The operator closed the PR on GitHub. Options, filed as a question:

- park the task with the reason "PR closed without a merge" (recommended: a
  closed PR is a decision a person made, like `canceled`);
- return it to the queue at the same rung;
- cancel the issue.

## 4. The land step's mode decides the merge

Decision (operator): in every mode the task completes when the PR merges.

| Mode | Publish | Merge |
|---|---|---|
| `on` | yes | foreman merges when the review is posted and the required checks pass |
| `ask` | yes | the task waits in Needs you as an ask for `land`; `foreman approve <id>` grants it, then foreman merges as in `on` |
| `off` | yes | foreman does not merge; the operator merges on GitHub, and foreman completes the task when it reads `MERGED` |

This changes what the gate before a PR landing holds. Today the land gate
holds the whole land block. For a PR landing it holds the merge only, because
in `off` the PR must still open. Publish runs with no policy step.

Conflict with an earlier rule: `docs/pipeline-engine.md` ("Every agent has a
gate on each path into it … A step that spends without a policy step would be
one the operator cannot stop"). Publish spends no model, but it is visible
outside this machine (a push and a PR). The operator decision above wins for
the merge; whether publish needs its own step is filed as a question.
Recommendation: publish follows the `land` step's pause only (a paused project
publishes nothing), and needs no step of its own.

A paused fleet or project still reads PR state and publishes it, and writes
nothing: it neither publishes, merges nor completes.

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

### Auth

foreman holds no token. Every call is `gh`, which uses the account
`gh auth login` set up (or `GH_TOKEN`). `gh auth status` at startup names a
missing login once, and each GitHub project then reads as unreachable with that
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

## 6. Choosing GitHub, and what else changes

### Where the choice lives

Filed as a question, with three options:

- **A** (recommended): the policy file, `projects.<name>.tracker: "github"`,
  set by `foreman policy tracker github --project <name>`. The policy is where
  per-project operator intention lives, and the dispatcher already reads it
  every pass.
- **B**: a checked-in file in the project, as `scripts/verify.sh` is, so the
  project records it.
- **C**: derive it: a checkout whose `origin` is on GitHub and that has no prog
  tasks. This guesses, and a project can be on GitHub and use prog.

The repo is always derived from the checkout (`gh repo view`), never stored.

### What changes

| Part | Change |
|---|---|
| `src/tracker.ts` | unchanged interface. `ProjectTracker` routes by the id's project prefix (`ready`, `list`, `dependencies` by the project argument) to `TasksTracker` or `GithubTracker`. |
| `src/github-tracker.ts` | new: the adapter of section 1 and the reading of section 5. |
| `src/records.ts` | `layer` takes `Tracker` from `ProjectTracker`; `together` keeps the records half; records first, then the move (section 1). |
| `src/dispatcher.ts` | settle completes a `Landed` task that is not `done`; `land` branches on `how: pull-request` to publish, read the PR, merge; the tip of a task at a PR landing is the PR head; a project whose tracker did not answer takes no step. |
| `src/repository.ts` | `push` (a commit to a remote branch) and `fetch` (the PR head into the task branch). |
| `src/github.ts` | new: PR reads and writes (`gh pr create`, `list`, `review`, `merge`, `checks`), beside `Repository` so nothing above it runs `gh pr`. |
| `src/pipeline.ts` | `LANDINGS` gains `pull-request`; validation names a PR landing in a project with no repo. |
| `src/policy.ts` | the tracker choice (option A). |
| `src/prompt.ts` | the read and log commands an agent is told come from the tracker: `gh issue view <n> -R <repo> --comments` and `gh issue comment <n> -R <repo>` for a GitHub project, instead of `tasks show` and `tasks log`. |
| `src/published.ts`, `src/view.ts` | `url`, `pr`, project `tracker`, `repo`, `unreachable` (section 2). |
| herdr-web | the board links the id to the issue, shows the PR column (`waiting`), and shows an unreachable project as held. |
| herdr-app panes | the foreman panel shows the same fields from `state.json`; the pipeline pane offers `pull-request` from `choices`, with no code of its own. |
| AGENTS.md | "Every task with a branch ends by merging into the project's main checkout" and "landing is the only code path that moves the operator's branch" hold for local landings only; a PR landing moves the remote trunk, and the operator's checkout takes it by its own pull. |

## Rules this changes

- `AGENTS.md`, Ports: "A records write that goes with a status move shares one
  transaction with it": holds for prog projects; a GitHub project writes the
  records first (section 1).
- `docs/pipeline-engine.md`, Validation: every step needs a gate; for a PR
  landing the gate holds the merge, not the publish (section 4).
- `AGENTS.md`, "A landing is proved somewhere disposable": a PR landing is
  proved by the repo's required checks, not the proving ground (section 3).
- `docs/workspace-blocks.md`, land block: `how` gains `pull-request`.
