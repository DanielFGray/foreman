# Proposal: foreman reads the model registry, the CLI replaces skill scripting

The herd skill currently teaches coordinators model knowledge as prose and
shell recipes: which pool a model draws on, what launch flags it needs, how to
record a trial row, how to move a model to proven. Foreman already dispatches
from the same ladder shape and already writes trial rows — but keeps its own
copies (config `ladder`, `trials.ts` `POOLS`) and launches with no
reasoning-effort flags, so its codex workers run at `low` where the skill
demands `medium`. This proposal moves the knowledge behind foreman commands so
that neither a human coordinator nor an agent needs the recipes.

Non-goals: council calls, commit discipline and defect typing stay human (see
`trials.ts`: judgements foreman cannot derive are left null). The `herd-models`
catalog comparison keeps working as-is and is not ported here. Size-aware
dispatch (`size:s/m/l` labels, `rounds` from settle history) is a follow-up,
listed at the end.

## A. Foreman reads the registry

The registry is `~/.agents/model-trials.db`: `providers`, `pools`,
`pool_aliases`, `models`, `aliases`, `ladder`, with `model_status` and
`herd_roster` views (schema owned by this repo after this proposal — see
`Registry` below).

**Ladder.** Each tick loads enabled rungs from the `ladder` table (joined to
`models` for harness and `thinking`), cheapest first. When the database or its
tables are absent, the config `ladder` applies exactly as today — the same
graceful-absence rule `trials.ts` already uses for writing. `herd-ladder
--sync` is then deleted: there is one source, and nothing to sync. The config
`ladder` stays as the cold-start fallback, not as the edited list.

**Pools.** `trials.ts` `POOLS` is replaced by a registry read (`pools` plus
`pool_aliases`, bare ids via `models.provider`). This fixes a live
disagreement: foreman spells the pool `Copilot`, the registry spells it
`GitHub Copilot`, so the first copilot trial foreman records would fragment
`model_status`. Unknown pools keep today's honest fallback (written as-is).

**Effort flags.** The multiplexer adapter (`herdr.ts`, which already owns the
per-harness model mapping) passes the rung's `thinking` at launch: codex
`-c model_reasoning_effort=<t>`, claude `--effort <t>`, pi `--thinking <t>`;
`auto` (cursor) and opencode (TUI picker) pass nothing. This is a correctness
fix, not a tuning: without it every foreman codex worker runs at the config
default `low`.

## C. Walls: no new protocol

Workers already escalate through `needs-you`, which parks the task, and report
walls to the planner directly in `prog log` — that path stays as-is. No
`wall:` labels, no re-probe machinery, no `foreman wall` command. The
reasoning: a wall report is a judgement call in context (per-key throttle vs
spent window vs unfunded account), and the planner — human or reviewing
operator — already converts it into action. Foreman's existing machinery
covers the unattended case well enough: a walled run settles `Unfinished`,
`attemptsPerRung` bounds the retries on a spent rung, the quota poll walls
the account, and the failures climb the task. Building a parallel
machine-readable wall channel would duplicate that loop for one wasted retry
of latency.

Out of scope with it: workers naming a *cheaper* rung to drop to (downward
moves re-hand finished work to models that failed it — the ladder's
upward-only rule holds), and workers retiring models (quality judgements stay
human).

## CLI surface replacing skill scripting

Each command degrades to a clear error when the registry is absent, naming the
file it looked for. After these land, the skill's model sections shrink to
pointers and the scripts go away in this order: `--sync` (with A),
`herd-ladder` print (with `foreman ladder`), `model-rates` (with `foreman
rates`), the INSERT heredoc (with `foreman trials record`), the SELECT recipes
(with the read commands), `backfill-trials` (with `foreman trials backfill`).

| command | replaces | notes |
|---|---|---|
| `foreman ladder` | `herd-ladder` print | rungs, status, record, launch args, from the registry |
| `foreman ladder --drift` | `herd-ladder --drift` | same check (opencode models vs registry), new home |
| `foreman ladder add\|disable <rung>` | `INSERT` / `UPDATE ladder SET enabled=0` | names, not ranks, on the command line |
| `foreman rates <model>... [-p provider]` | `model-rates` | keeps the median-slice column and the registry resolve for bare ids |
| `foreman trials record --task --outcome [--rounds ...]` | INSERT heredoc | validates enums and the model row; never invents judgements |
| `foreman trials summary\|--by-size\|roster` | raw SELECT recipes | the three views, human and `--json` like `quota` |
| `foreman trials backfill [--write]` | `backfill-trials` | moved here from the skills repo; the skill keeps no copy |
| `foreman registry apply` | `sqlite3 ... < schema-registry.sql` | idempotent; the schema file moves into this repo |

## Registry ownership

The schema file moves from the skills repo to foreman (e.g. `assets/` or
`src/registry.sql`); foreman writes rows and reads the ladder from it, so the
shape is its contract. The coordinator's hand-written rows target the same
schema. Seed changes (new models, alias additions) stay reviewable as SQL
diffs; `registry apply` remains rerunnable and never rewrites `trials`.

## Rollout

1. A + adapter flags, behind the graceful-absence fallback; unit tests on the
   loader plus one live `--slots 1` dispatch proving the effort flag in the
   pane footer.
2. CLI table above, command by command; each one deletes its skill-side
   original when the skill is edited to point at it.
3. Skill edit (skills repo): model sections become pointers; the ladder/rate
   policy prose stays, the recipes go.

Follow-up, not this proposal: `rounds` from settle history, `size:` labels
with size-aware starting rungs, and the `foreman models` port.

## Questions

1. Config `ladder`: fallback-forever as proposed, or deleted once the registry
   read is proven live?
