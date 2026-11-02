import { Effect } from "effect";
import * as Migrator from "effect/sql/Migrator";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The tables of the store, as Effect migrations.
 *
 * `0001_tasks` creates the task and learning tables as Go `prog` leaves them
 * after its last migration, so `tasks` can make a store on its own. Every
 * statement is `IF NOT EXISTS`: on a store `prog` already made, it does nothing.
 *
 * A store without a `user_version` gets the one Go leaves after its last
 * migration (`GO_SCHEMA_VERSION`); without it, Go would run its migrations again
 * over these tables. Go owns the number from then on. Migrations record themselves in
 * `tasks_migrations`.
 */
export const MIGRATIONS = Migrator.fromRecord({
  "0001_tasks": Effect.gen(function* () {
    const sql = yield* SqlClient;
    for (const statement of TASKS) yield* sql.unsafe(statement);
    const version = yield* sql.unsafe<{ user_version: number }>("PRAGMA user_version");
    if (version[0]?.user_version === 0)
      yield* sql.unsafe(`PRAGMA user_version = ${GO_SCHEMA_VERSION}`);
  }),
  "0002_registry": Effect.gen(function* () {
    const sql = yield* SqlClient;
    for (const statement of REGISTRY) yield* sql.unsafe(statement);
  }),
  // An author that commits onto the operator's branch (a pipeline with no
  // branch block) has no fork point git can name, so its run records the
  // commit it started from. A run on a task branch leaves it empty: git keeps
  // that branch's fork point.
  "0003_run_base": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(`ALTER TABLE runs ADD COLUMN base TEXT`);
  }),
});

export const MIGRATIONS_TABLE = "tasks_migrations";

/**
 * Tasks (`items`, `deps`, `logs`, `projects`, `labels`, `item_labels`) and
 * learnings (`concepts`, `learnings`, their full-text index, sources and
 * relations). Names match Go's, because Go reads the same file.
 */
const TASKS = [
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority INTEGER DEFAULT 2,
    parent_id TEXT REFERENCES items(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    definition_of_done TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS deps (
    item_id TEXT REFERENCES items(id),
    depends_on TEXT REFERENCES items(id),
    PRIMARY KEY (item_id, depends_on)
  )`,
  `CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY,
    item_id TEXT REFERENCES items(id),
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project TEXT NOT NULL,
    color TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (name, project)
  )`,
  `CREATE TABLE IF NOT EXISTS item_labels (
    item_id TEXT REFERENCES items(id),
    label_id TEXT REFERENCES labels(id),
    PRIMARY KEY (item_id, label_id)
  )`,
  `CREATE TABLE IF NOT EXISTS concepts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    summary TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS learnings (
    id TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    task_id TEXT REFERENCES items(id) ON DELETE SET NULL,
    summary TEXT NOT NULL,
    detail TEXT,
    status TEXT DEFAULT 'active'
  )`,
  `CREATE TABLE IF NOT EXISTS learning_concepts (
    learning_id TEXT REFERENCES learnings(id),
    concept_id TEXT REFERENCES concepts(id),
    PRIMARY KEY (learning_id, concept_id)
  )`,
  `CREATE TABLE IF NOT EXISTS learning_sources (
    id TEXT PRIMARY KEY,
    learning_id TEXT NOT NULL REFERENCES learnings(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    note TEXT,
    CHECK (
      (start_line IS NULL AND end_line IS NULL)
      OR (start_line IS NOT NULL AND start_line > 0 AND end_line IS NULL)
      OR (start_line IS NOT NULL AND end_line IS NOT NULL
        AND start_line > 0 AND end_line >= start_line)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS learning_relations (
    source_id TEXT NOT NULL REFERENCES learnings(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES learnings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind = 'supersedes'),
    CHECK (source_id != target_id),
    PRIMARY KEY (source_id, target_id, kind)
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
    summary,
    detail,
    content='learnings',
    content_rowid='rowid'
  )`,
  `CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN
    INSERT INTO learnings_fts(rowid, summary, detail)
    VALUES (NEW.rowid, NEW.summary, NEW.detail);
  END`,
  `CREATE TRIGGER IF NOT EXISTS learnings_ad AFTER DELETE ON learnings BEGIN
    INSERT INTO learnings_fts(learnings_fts, rowid, summary, detail)
    VALUES ('delete', OLD.rowid, OLD.summary, OLD.detail);
  END`,
  `CREATE TRIGGER IF NOT EXISTS learnings_au AFTER UPDATE ON learnings BEGIN
    INSERT INTO learnings_fts(learnings_fts, rowid, summary, detail)
    VALUES ('delete', OLD.rowid, OLD.summary, OLD.detail);
    INSERT INTO learnings_fts(rowid, summary, detail)
    VALUES (NEW.rowid, NEW.summary, NEW.detail);
  END`,
  `CREATE INDEX IF NOT EXISTS idx_items_project ON items(project)`,
  `CREATE INDEX IF NOT EXISTS idx_items_status ON items(status)`,
  `CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_item ON logs(item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_labels_project ON labels(project)`,
  `CREATE INDEX IF NOT EXISTS idx_item_labels_item ON item_labels(item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_item_labels_label ON item_labels(label_id)`,
  `CREATE INDEX IF NOT EXISTS idx_learning_concepts_concept ON learning_concepts(concept_id)`,
  `CREATE INDEX IF NOT EXISTS idx_learnings_task ON learnings(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_learnings_status ON learnings(status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_sources_unique
    ON learning_sources(learning_id, path, ifnull(start_line, -1), ifnull(end_line, -1))`,
  `CREATE INDEX IF NOT EXISTS idx_learning_relations_target ON learning_relations(target_id)`,
];

/**
 * The model registry and the record of runs, moved here from the herd skill's
 * `model-trials.db` so that tasks, the runs on them and the models that ran
 * them live in one file.
 *
 * `runs` is the old `trials` table, with a run able to be open: `closed_at` and
 * `outcome` are both empty until it ends, and the check keeps them together.
 * `node` names the pipeline block the run belongs to, so a task's place in its
 * pipeline is replayed from its runs rather than stored.
 * `commit` and `ending` are foreman's own record of a run (see `runs.ts`); a run
 * recorded by hand or imported leaves both empty.
 * `closed_at` keeps its default, so a closed run recorded by hand still needs
 * only its outcome. Every view that counts or averages runs reads closed runs
 * only, so an open run never counts as a slice.
 *
 * A `check` run is a pipeline check block's command, not a model's work: it
 * has no kind, pool, model or outcome, it is written closed with its ending,
 * and the views about models leave it out.
 */
const REGISTRY = [
  `CREATE TABLE providers (
    provider   TEXT PRIMARY KEY,
    models_dev TEXT,              -- models.dev provider id; NULL = models.dev has none
    note       TEXT
  )`,
  `CREATE TABLE pools (
    pool             TEXT PRIMARY KEY,   -- canonical quota pool
    harness          TEXT NOT NULL,      -- primary herdr kind; notes name kinds that share it
    quota_cmd        TEXT,               -- how to check the window; NULL = per-model limits only
    provider_default TEXT NOT NULL,      -- run identity provider for bare model ids
    notes            TEXT
  )`,
  `CREATE TABLE pool_aliases (
    alias TEXT PRIMARY KEY,              -- spelling found in runs.pool
    pool  TEXT NOT NULL REFERENCES pools(pool)
  )`,
  `CREATE TABLE models (
    model       TEXT PRIMARY KEY,        -- exact harness id, as in runs.model
    provider    TEXT NOT NULL,           -- pi-catalog provider, for herd-models identity
    pool        TEXT NOT NULL REFERENCES pools(pool),
    harness     TEXT NOT NULL,           -- herdr kind used to launch it
    models_dev  TEXT,                    -- exact models.dev provider/bare key; NULL = none
    tier        TEXT NOT NULL CHECK (tier IN ('free','metered','frontier')),
    limit_scope TEXT NOT NULL CHECK (limit_scope IN ('pool','model')),
    thinking    TEXT NOT NULL DEFAULT 'medium',  -- medium | low | auto (cursor picks)
    retired     INTEGER NOT NULL DEFAULT 0,
    notes       TEXT
  )`,
  `CREATE TABLE aliases (
    alias TEXT PRIMARY KEY,              -- spelling found in runs.model
    model TEXT NOT NULL REFERENCES models(model)
  )`,
  `CREATE TABLE ladder (
    rank      INTEGER PRIMARY KEY,       -- cheapest first; the order only, rewritten by every ladder write
    rung      TEXT NOT NULL UNIQUE,      -- foreman rung name
    model     TEXT NOT NULL REFERENCES models(model),
    enabled   INTEGER NOT NULL DEFAULT 1,
    provider  TEXT,                      -- foreman provider field, when one is set
    note      TEXT,
    unmetered INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE prices (
    model       TEXT PRIMARY KEY,        -- as in runs.model
    source      TEXT NOT NULL,           -- models.dev provider/model the price came from
    -- USD per million tokens. NULL = models.dev states no rate, which is not 0.
    input       REAL,
    output      REAL,
    cache_read  REAL,
    cache_write REAL,
    fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE runs (
    id                 INTEGER PRIMARY KEY,
    project            TEXT NOT NULL,
    task               TEXT NOT NULL,
    slice              TEXT NOT NULL,
    kind               TEXT,             -- NULL only for a check, which runs no model
    pool               TEXT,
    model              TEXT,
    rung               TEXT,             -- foreman rung; NULL for a run launched by hand
    node               TEXT,             -- the pipeline block it ran at; NULL outside a pipeline
    work               TEXT NOT NULL CHECK (work IN ('build', 'correction', 'research', 'review', 'check')),
    started_at         TEXT,             -- NULL for runs recorded before starts were kept
    closed_at          TEXT DEFAULT (datetime('now')),  -- NULL while the run is open
    outcome            TEXT CHECK (outcome IN ('committed', 'dropped', 'handed-off', 'answered')),
    "commit"           TEXT,             -- author: the branch tip when it closed; review: the tip its reviewer reads, moved by a correction round; check: the tip it ran on
    ending             TEXT,             -- how the run stopped; an agent's verdict may stand on an open run, a settle ending needs a closed one
    rounds             INTEGER,
    report_accurate    INTEGER CHECK (report_accurate IN (0, 1)),
    source             TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'backfill')),
    evidence           TEXT,
    notes              TEXT,
    session            TEXT,
    active_minutes     REAL,
    input_tokens       INTEGER,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER,
    output_tokens      INTEGER,
    reasoning_tokens   INTEGER,
    actual_cost_usd    REAL,
    size               INTEGER CHECK (size >= 1),  -- 1 one file or rule, 2 one package, 3 crosses packages
    CHECK (CASE WHEN work = 'check'
      THEN kind IS NULL AND pool IS NULL AND model IS NULL AND outcome IS NULL
           AND closed_at IS NOT NULL AND ending IN ('passed', 'failed')
      ELSE kind IS NOT NULL AND pool IS NOT NULL AND model IS NOT NULL
           AND (closed_at IS NULL) = (outcome IS NULL) END),
    CHECK (ending IS NULL OR closed_at IS NOT NULL OR ending IN ('approved', 'returned', 'satisfied')),
    CHECK (ending IS NULL
      OR (work = 'review' AND ending IN ('approved', 'returned', 'no-verdict', 'walled', 'released'))
      OR (work = 'check' AND ending IN ('passed', 'failed'))
      OR (work IN ('build', 'correction', 'research')
          AND ending IN ('handed-off', 'satisfied', 'unfinished', 'walled', 'vanished', 'released', 'canceled')))
  )`,
  `CREATE INDEX idx_runs_task ON runs(task)`,
  `CREATE TABLE defects (
    run_id INTEGER NOT NULL REFERENCES runs(id),
    kind   TEXT NOT NULL CHECK (kind IN (
             'patch-around-wall',   -- flag, shim, fallback, second path
             'missed-caller',       -- a caller or copy left behind
             'duplication',         -- re-implemented something that exists
             'derivable-state',     -- stored or passed what could be computed
             'dead-code',           -- left code that nothing reaches
             'unverified-claim',    -- report claims something the evidence does not show
             'wrong-citation',      -- file:line or source that does not say that
             'scope-breach',        -- touched paths outside the slice
             'test-weakened',       -- test skipped, deleted or made vacuous
             'design-error',        -- wrong shape, not a local mistake
             'tool-misuse',         -- forbidden tool, untee'd tests, files left in the repo
             'comment-loss',        -- deleted a comment that stated why
             'stall'                -- stopped mid-task, quota, crash, lost track
           )),
    detail TEXT NOT NULL
  )`,
  `CREATE VIEW run_cost AS
  SELECT t.id, t.project, t.task, t.model, t.active_minutes,
         t.input_tokens + coalesce(t.cache_read_tokens, 0) + coalesce(t.cache_write_tokens, 0) + t.output_tokens AS total_tokens,
         round((CASE WHEN t.input_tokens = 0 THEN 0 ELSE t.input_tokens * p.input END
              + CASE WHEN coalesce(t.cache_read_tokens, 0) = 0 THEN 0 ELSE t.cache_read_tokens * p.cache_read END
              + CASE WHEN coalesce(t.cache_write_tokens, 0) = 0 THEN 0 ELSE t.cache_write_tokens * p.cache_write END
              + CASE WHEN t.output_tokens = 0 THEN 0 ELSE t.output_tokens * p.output END) / 1e6, 4) AS list_cost_usd,
         t.actual_cost_usd
  FROM runs t LEFT JOIN prices p ON p.model = t.model
  WHERE t.input_tokens IS NOT NULL AND t.closed_at IS NOT NULL`,
  `CREATE VIEW model_summary AS
  SELECT t.model,
         count(*)                                         AS slices,
         sum(t.source = 'live')                           AS live,
         sum(t.outcome IN ('committed', 'answered'))      AS succeeded,
         round(avg(t.rounds), 2)                          AS avg_rounds,
         round(avg(t.report_accurate), 2)                 AS report_accuracy,
         count(t.report_accurate)                         AS reports_checked,
         (SELECT count(*) FROM defects d JOIN runs u ON u.id = d.run_id WHERE u.model = t.model) AS defects,
         count(t.input_tokens)                            AS slices_measured,
         round(avg(t.active_minutes), 1)                  AS avg_minutes,
         -- averaged over slices_costed only: a slice that used a token kind at an unknown rate has no cost
         (SELECT round(avg(c.list_cost_usd), 4) FROM run_cost c WHERE c.model = t.model) AS avg_list_cost_usd,
         (SELECT count(c.list_cost_usd) FROM run_cost c WHERE c.model = t.model) AS slices_costed
  FROM runs t
  WHERE t.closed_at IS NOT NULL AND t.work <> 'check'
  GROUP BY t.model`,
  `CREATE VIEW size_summary AS
  SELECT t.model, t.size,
         count(*)                                             AS slices,
         sum(t.outcome IN ('committed','answered'))           AS succeeded,
         round(avg(t.rounds), 2)                              AS avg_rounds,
         round(avg(t.active_minutes), 1)                      AS avg_minutes,
         count(c.list_cost_usd)                               AS slices_costed,
         round(sum(c.list_cost_usd), 4)                       AS total_list_cost_usd,
         -- spend on every attempt, failures included, per slice that landed: the number that says
         -- whether a dearer model is cheaper for this size of work
         round(sum(c.list_cost_usd) / nullif(sum(t.outcome IN ('committed','answered')), 0), 4) AS cost_per_success_usd
  FROM runs t LEFT JOIN run_cost c ON c.id = t.id
  WHERE t.size IS NOT NULL AND t.closed_at IS NOT NULL
  GROUP BY t.model, t.size`,
  `CREATE VIEW run_identity AS
  SELECT t.*,
    COALESCE(pa.pool, t.pool) AS cpool,
    COALESCE(a.model, t.model) AS cmodel
  FROM runs t
  LEFT JOIN pool_aliases pa ON pa.alias = t.pool
  LEFT JOIN aliases a ON a.alias = t.model
  WHERE t.closed_at IS NOT NULL AND t.work <> 'check'`,
  `CREATE VIEW model_status AS
  SELECT m.model, m.provider, m.pool, m.harness, m.tier, m.limit_scope,
         m.thinking, m.retired, m.models_dev,
         l.rank, l.rung, l.enabled, l.provider AS rung_provider,
         COUNT(t.id) AS slices,
         COALESCE(SUM(t.outcome IN ('committed','answered')), 0) AS succeeded,
         ROUND(AVG(t.rounds), 2) AS avg_rounds,
         ROUND(AVG(t.report_accurate), 2) AS report_accuracy,
         COUNT(t.report_accurate) AS reports_checked,
         (SELECT COUNT(*) FROM defects d
            JOIN run_identity u ON u.id = d.run_id
           WHERE u.cmodel = m.model) AS defects,
         CASE WHEN m.retired THEN 'retired'
              WHEN COALESCE(SUM(t.outcome IN ('committed','answered')), 0) >= 2 THEN 'proven'
              ELSE 'trial' END AS status
  FROM models m
  LEFT JOIN ladder l ON l.model = m.model
  LEFT JOIN run_identity t ON t.cmodel = m.model
  GROUP BY m.model`,
  `CREATE VIEW herd_roster AS
  SELECT p.pool, p.harness, p.quota_cmd,
    (SELECT GROUP_CONCAT(s.model, ', ')
       FROM (SELECT m2.model FROM model_status m2
              WHERE m2.pool = p.pool AND m2.status = 'proven' AND COALESCE(m2.enabled, 1) = 1
              ORDER BY m2.rank NULLS LAST, m2.model LIMIT -1) s) AS proven,
    (SELECT GROUP_CONCAT(s.model, ', ')
       FROM (SELECT m2.model FROM model_status m2
              WHERE m2.pool = p.pool AND m2.status = 'trial' AND COALESCE(m2.enabled, 1) = 1
              ORDER BY m2.rank NULLS LAST, m2.model LIMIT -1) s) AS on_trial
  FROM pools p`,
];

/** `PRAGMA user_version` after Go `prog`'s last migration. */
const GO_SCHEMA_VERSION = 8;
