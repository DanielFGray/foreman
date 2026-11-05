import { Effect } from "effect";
import * as Migrator from "effect/sql/Migrator";
import { SqlClient } from "effect/sql/SqlClient";
import { PROCESS_ENDINGS } from "./endings.ts";

/**
 * The tables of the store, as Effect migrations.
 *
 * `0001_tasks` creates task tables in the layout shared with Go `prog` stores.
 * Every statement is `IF NOT EXISTS`.
 *
 * A store without a `user_version` gets `GO_SCHEMA_VERSION` (the version that
 * layout corresponds to). Migrations record themselves in `tasks_migrations`.
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
  // An agent run's ending is an exit name the agent named, or a process
  // ending foreman observed. The CHECK accepts any exit name for agent runs.
  // SQLite cannot alter a CHECK, so the table is rebuilt; the views that read
  // it are dropped first and made again after, and the foreign key from
  // `defects` is checked at commit, when the rebuilt table holds every id.
  "0004_exits": withViewsRebuilt(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`PRAGMA defer_foreign_keys = ON`);
      const columns = yield* sql.unsafe<{ name: string }>(
        `SELECT name FROM pragma_table_info('runs')`,
      );
      const list = columns.map((column) => `"${column.name}"`).join(", ");
      yield* sql.unsafe(RUNS.replace("CREATE TABLE runs (", "CREATE TABLE runs_next ("));
      yield* sql.unsafe(`ALTER TABLE runs_next ADD COLUMN base TEXT`);
      yield* sql.unsafe(
        `INSERT INTO runs_next (${list}) SELECT ${list.replace(
          `"ending"`,
          `CASE ending WHEN 'handed-off' THEN 'done' WHEN 'satisfied' THEN 'already-done'
         WHEN 'no-verdict' THEN 'stopped' WHEN 'unfinished' THEN 'stopped' ELSE ending END`,
        )} FROM runs`,
      );
      yield* sql.unsafe(`DROP TABLE runs`);
      yield* sql.unsafe(`ALTER TABLE runs_next RENAME TO runs`);
      yield* sql.unsafe(`CREATE INDEX idx_runs_task ON runs(task)`);
    }),
  ),
  // Which roles a rung may fill. The operator turns author or review off per
  // rung so a free model can write but never read, without retiring it.
  "0005_ladder_roles": Effect.gen(function* () {
    const sql = yield* SqlClient;
    const columns = yield* sql.unsafe<{ name: string }>(
      `SELECT name FROM pragma_table_info('ladder')`,
    );
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("author")) {
      yield* sql.unsafe(`ALTER TABLE ladder ADD COLUMN author INTEGER NOT NULL DEFAULT 1`);
    }
    if (!names.has("review")) {
      yield* sql.unsafe(`ALTER TABLE ladder ADD COLUMN review INTEGER NOT NULL DEFAULT 1`);
    }
  }),
  // Six life statuses: `reviewing` named a pipeline step that placement already
  // derives from the last exit, so storing it kept one fact twice. Existing
  // reviewing tasks become in_progress; their placement is unchanged.
  "0006_six_statuses": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(`UPDATE items SET status = 'in_progress' WHERE status = 'reviewing'`);
  }),
  // Two records foreman keeps beside the task's runs, so a tracker carries only task state: the rungs charged with
  // failing a task, and the tasks parked for the operator.
  "0007_charges_and_parks": Effect.gen(function* () {
    const sql = yield* SqlClient;
    for (const statement of CHARGES_AND_PARKS) yield* sql.unsafe(statement);
  }),
  // Which models sit on the council. A model is a worker (a ladder rung), a
  // council member, both or neither, so the switch is on the model, not the
  // rung. Every model starts off: the operator names the members.
  "0008_council": Effect.gen(function* () {
    const sql = yield* SqlClient;
    const columns = yield* sql.unsafe<{ name: string }>(
      `SELECT name FROM pragma_table_info('models')`,
    );
    if (!columns.some((column) => column.name === "council")) {
      yield* sql.unsafe(`ALTER TABLE models ADD COLUMN council INTEGER NOT NULL DEFAULT 0`);
    }
  }),
  // The ladder becomes an ordered list of levels: each rung stands at a level,
  // and the rungs of one level share the author work. Every rung starts alone
  // in its level (level = rank), so nothing changes until the operator groups
  // rungs. The level has no default, because a writer that left it out would
  // put the rung in some level by accident; SQLite adds a NOT NULL column only
  // with a default, so the table is rebuilt, with the views that read it.
  "0009_ladder_levels": withViewsRebuilt(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        LADDER_LEVELS.replace("CREATE TABLE ladder (", "CREATE TABLE ladder_next ("),
      );
      yield* sql.unsafe(
        `INSERT INTO ladder_next (rank, level, rung, model, enabled, provider, note, unmetered, author, review)
       SELECT rank, rank, rung, model, enabled, provider, note, unmetered, author, review FROM ladder`,
      );
      yield* sql.unsafe(`DROP TABLE ladder`);
      yield* sql.unsafe(`ALTER TABLE ladder_next RENAME TO ladder`);
    }),
  ),
  // The council becomes the reviewers: a list of its own, each entry a model
  // with its own thinking level and account, from which a review block takes
  // its reader. The ladder then decides only who writes, so the rung's review
  // switch goes. Each council member becomes a reviewer named after the
  // lowest rung that runs its model, with that rung's account, so the review
  // runs already recorded under that rung's name read as the reviewer's; a
  // member no rung runs is named by its model id.
  //
  // Each migration checks the columns it reads before it changes a table.
  "0010_reviewers": withViewsRebuilt(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(REVIEWERS);
      const has = (table: string, column: string) =>
        sql
          .unsafe<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
          .pipe(Effect.map((columns) => columns.some((one) => one.name === column)));
      if (yield* has("models", "council")) {
        yield* sql.unsafe(
          `INSERT OR IGNORE INTO reviewers (reviewer, model, thinking, provider)
           SELECT coalesce(
                    (SELECT l.rung FROM ladder l WHERE l.model = m.model
                      ORDER BY l.level, l.rank LIMIT 1),
                    m.model),
                  m.model, m.thinking,
                  (SELECT l.provider FROM ladder l WHERE l.model = m.model
                    ORDER BY l.level, l.rank LIMIT 1)
             FROM models m WHERE m.council <> 0 AND m.retired = 0`,
        );
        yield* sql.unsafe(`ALTER TABLE models DROP COLUMN council`);
      }
      if (yield* has("ladder", "review")) {
        yield* sql.unsafe(LADDER.replace("CREATE TABLE ladder (", "CREATE TABLE ladder_next ("));
        yield* sql.unsafe(
          `INSERT INTO ladder_next (rank, level, rung, model, enabled, provider, note, unmetered, author)
           SELECT rank, level, rung, model, enabled, provider, note, unmetered, author FROM ladder`,
        );
        yield* sql.unsafe(`DROP TABLE ladder`);
        yield* sql.unsafe(`ALTER TABLE ladder_next RENAME TO ladder`);
      }
    }),
  ),
  // Model advice reads price from the catalog. SQLite drops the price class
  // column while keeping model rows and foreign keys. The column check makes
  // this migration safe when the schema already lacks tier.
  "0011_no_price_class": withViewsRebuilt(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const columns = yield* sql.unsafe<{ name: string }>(
        `SELECT name FROM pragma_table_info('models')`,
      );
      if (columns.some((column) => column.name === "tier")) {
        yield* sql.unsafe(`ALTER TABLE models DROP COLUMN tier`);
      }
    }),
  ),
  // Each rung and reviewer stores its thinking level, so one model can have
  // different levels in different roles. A rung takes its model's level.
  // `auto` becomes absent because an absent level uses the harness default.
  // Each step checks its input columns before it changes a table.
  "0012_rung_thinking": withViewsRebuilt(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const columnsOf = (table: string) =>
        sql.unsafe<{ name: string; notnull: number }>(
          `SELECT name, "notnull" FROM pragma_table_info('${table}')`,
        );
      if (!(yield* columnsOf("ladder")).some((column) => column.name === "thinking")) {
        yield* sql.unsafe(`ALTER TABLE ladder ADD COLUMN thinking TEXT`);
      }
      if ((yield* columnsOf("models")).some((column) => column.name === "thinking")) {
        yield* sql.unsafe(
          `UPDATE ladder SET thinking =
             (SELECT nullif(m.thinking, 'auto') FROM models m WHERE m.model = ladder.model)`,
        );
        yield* sql.unsafe(`ALTER TABLE models DROP COLUMN thinking`);
      }
      const reviewerLevel = (yield* columnsOf("reviewers")).find(
        (column) => column.name === "thinking",
      );
      if (reviewerLevel?.notnull) {
        yield* sql.unsafe(
          REVIEWERS_LEVELS.replace("CREATE TABLE reviewers (", "CREATE TABLE reviewers_next ("),
        );
        yield* sql.unsafe(
          `INSERT INTO reviewers_next (reviewer, model, thinking, provider)
           SELECT reviewer, model, nullif(thinking, 'auto'), provider FROM reviewers`,
        );
        yield* sql.unsafe(`DROP TABLE reviewers`);
        yield* sql.unsafe(`ALTER TABLE reviewers_next RENAME TO reviewers`);
      }
    }),
  ),
  // Go `prog` stores contain learning tables. The `tasks` CLI does not read or
  // write them, so each table is dropped
  // after the tables whose foreign keys name it, and its triggers go with it.
  "0013_no_learnings": Effect.gen(function* () {
    const sql = yield* SqlClient;
    for (const table of [
      "learnings_fts",
      "learning_relations",
      "learning_sources",
      "learning_concepts",
      "learnings",
      "concepts",
    ])
      yield* sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
  }),
});

/**
 * Runs `rebuild` with the registry's views dropped, then recreates them.
 * SQLite checks every view when a table is renamed, so a table a view
 * reads cannot be replaced while the view stands.
 */
function withViewsRebuilt<E>(rebuild: Effect.Effect<void, E, SqlClient>) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient;
    const views = REGISTRY.flatMap((statement) => {
      const name = /^CREATE VIEW (\w+)/.exec(statement)?.[1];
      return name === undefined ? [] : [{ name, statement }];
    });
    for (const view of [...views].reverse()) yield* sql.unsafe(`DROP VIEW IF EXISTS ${view.name}`);
    yield* rebuild;
    for (const view of views) yield* sql.unsafe(view.statement);
  });
}

/**
 * The ladder that `0009_ladder_levels` makes: `rank` is the order of the whole
 * list and `level` groups it, so readers sort by (level, rank).
 */
const LADDER_LEVELS = `CREATE TABLE ladder (
    rank      INTEGER PRIMARY KEY,       -- the order by (level, rank); rewritten by every ladder write
    level     INTEGER NOT NULL,          -- levels climb in number; the rungs of one level are peers
    rung      TEXT NOT NULL UNIQUE,      -- foreman rung name
    model     TEXT NOT NULL REFERENCES models(model),
    enabled   INTEGER NOT NULL DEFAULT 1,
    provider  TEXT,                      -- foreman provider field, when one is set
    note      TEXT,
    unmetered INTEGER NOT NULL DEFAULT 0,
    author    INTEGER NOT NULL DEFAULT 1, -- may take the ladder (author) rule
    review    INTEGER NOT NULL DEFAULT 1  -- may take the above (review) rule
  )`;

/** The ladder that `0010_reviewers` makes: a rung only writes, so it has no review switch. */
const LADDER = `CREATE TABLE ladder (
    rank      INTEGER PRIMARY KEY,       -- the order by (level, rank); rewritten by every ladder write
    level     INTEGER NOT NULL,          -- levels climb in number; the rungs of one level are peers
    rung      TEXT NOT NULL UNIQUE,      -- foreman rung name
    model     TEXT NOT NULL REFERENCES models(model),
    enabled   INTEGER NOT NULL DEFAULT 1,
    provider  TEXT,                      -- foreman provider field, when one is set
    note      TEXT,
    unmetered INTEGER NOT NULL DEFAULT 0,
    author    INTEGER NOT NULL DEFAULT 1  -- may take the ladder (author) rule
  )`;

/**
 * The reviewers a review block takes its reader from. A review run records
 * its reviewer's name in `runs.rung`, as an author run records its rung's.
 * The run's work says which list the name is in, so a reviewer may share a
 * rung's name.
 */
const REVIEWERS = `CREATE TABLE IF NOT EXISTS reviewers (
    reviewer TEXT PRIMARY KEY,           -- the name review runs record
    model    TEXT NOT NULL REFERENCES models(model),
    thinking TEXT NOT NULL,              -- this entry's level, apart from the model row's
    provider TEXT                        -- the account it spends, where the model does not say
  )`;

/**
 * The reviewers that `0012_rung_thinking` makes: an absent level passes no
 * thinking flag, so the harness's own default applies.
 */
const REVIEWERS_LEVELS = `CREATE TABLE reviewers (
    reviewer TEXT PRIMARY KEY,           -- the name review runs record
    model    TEXT NOT NULL REFERENCES models(model),
    thinking TEXT,                       -- this entry's level; NULL = the harness's default
    provider TEXT                        -- the account it spends, where the model does not say
  )`;

export const MIGRATIONS_TABLE = "tasks_migrations";

/**
 * Task tables: `items`, `deps`, `logs`, `projects`, `labels`, and
 * `item_labels`.
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
  `CREATE INDEX IF NOT EXISTS idx_items_project ON items(project)`,
  `CREATE INDEX IF NOT EXISTS idx_items_status ON items(status)`,
  `CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_item ON logs(item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_labels_project ON labels(project)`,
  `CREATE INDEX IF NOT EXISTS idx_item_labels_item ON item_labels(item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_item_labels_label ON item_labels(label_id)`,
];

/**
 * The model registry and run records. Tasks, their runs, and the models that
 * ran them share one file.
 *
 * `runs` records agent and check runs. An agent run can be open: `closed_at` and
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
const PROCESS_ENDINGS_SQL = PROCESS_ENDINGS.map((ending) => `'${ending}'`).join(", ");

/**
 * The runs table. An agent run's ending is an exit name the agent named, which
 * may stand on an open run, or a process ending, which needs a closed one.
 */
const RUNS = `CREATE TABLE runs (
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
    "commit"           TEXT,             -- agent: the tip its exit was named on, or the branch tip when it closed; check: the tip it ran on
    ending             TEXT,             -- an exit the agent named, which may stand on an open run, or a process ending, which needs a closed one
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
    CHECK (ending IS NULL OR closed_at IS NOT NULL OR ending NOT IN (${PROCESS_ENDINGS_SQL})),
    CHECK (ending IS NULL
      OR (work = 'check' AND ending IN ('passed', 'failed'))
      OR (work <> 'check' AND ending <> '' AND ending NOT GLOB '*[^a-z-]*'))
  )`;

/**
 * The registry tables. Migrations update their columns and recreate the views
 * after table changes.
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
    harness     TEXT NOT NULL,           -- herdr kind that launched it
    models_dev  TEXT,                    -- exact models.dev provider/bare key; NULL = none
    tier        TEXT NOT NULL CHECK (tier IN ('free','metered','frontier')),
    limit_scope TEXT NOT NULL CHECK (limit_scope IN ('pool','model')),
    thinking    TEXT NOT NULL DEFAULT 'medium',  -- medium | low | auto (cursor picks)
    retired     INTEGER NOT NULL DEFAULT 0,
    notes       TEXT,
    council     INTEGER NOT NULL DEFAULT 0  -- sits on the council
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
    unmetered INTEGER NOT NULL DEFAULT 0,
    author    INTEGER NOT NULL DEFAULT 1, -- may take the ladder (author) rule
    review    INTEGER NOT NULL DEFAULT 1  -- may take the above (review) rule
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
  RUNS,
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
  SELECT m.model, m.provider, m.pool, m.harness, m.limit_scope,
         m.retired, m.models_dev,
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

/**
 * `charges`: one row each time a rung is charged with failing a task. `run` is
 * the newest run on the task when the charge was written, so the runs after it
 * are the ones the charge has not read; empty when the task had none.
 * `forgiven_at` is set when the operator takes the charge back.
 *
 * `parks`: one row per task parked for the operator, removed when they act.
 */
const CHARGES_AND_PARKS = [
  `CREATE TABLE charges (
    id          INTEGER PRIMARY KEY,
    task        TEXT NOT NULL,
    rung        TEXT NOT NULL,
    run         INTEGER REFERENCES runs(id),
    at          TEXT NOT NULL DEFAULT (datetime('now')),
    forgiven_at TEXT
  )`,
  `CREATE INDEX idx_charges_task ON charges(task)`,
  `CREATE TABLE parks (
    task   TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    at     TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

/** `PRAGMA user_version` matching the layout `0001_tasks` creates. */
const GO_SCHEMA_VERSION = 8;
