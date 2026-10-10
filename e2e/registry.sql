-- A scratch model registry for the end-to-end rig: the slice of the herd
-- skill's schema-registry.sql that foreman reads, with three rungs. Two
-- different models so a probe run exercises a climb, and one promotional rung so
-- the `unmetered` flag has a row to survive the round trip.
--
--   sqlite3 /tmp/foreman-e2e.db < e2e/registry.sql
--   FOREMAN_REGISTRY=/tmp/foreman-e2e.db foreman --config e2e/config.jsonc --slots 1
CREATE TABLE models(
  model    TEXT PRIMARY KEY,
  harness  TEXT NOT NULL,
  thinking TEXT NOT NULL DEFAULT 'medium'
);
CREATE TABLE ladder(
  rank      INTEGER PRIMARY KEY,
  rung      TEXT NOT NULL UNIQUE,
  model     TEXT NOT NULL REFERENCES models(model),
  enabled   INTEGER NOT NULL DEFAULT 1,
  provider  TEXT,
  unmetered INTEGER NOT NULL DEFAULT 0,
  note      TEXT
);
INSERT INTO models(model, harness, thinking) VALUES
  ('opencode/deepseek-v4-pro', 'opencode', 'medium'),
  ('opencode/claude-sonnet-5', 'opencode', 'medium'),
  ('opencode-go/ox-alpha-free', 'opencode', 'medium');
INSERT INTO ladder(rank, rung, model, unmetered) VALUES
  (1, 'cheap',  'opencode/deepseek-v4-pro', 0),
  (2, 'strong', 'opencode/claude-sonnet-5', 0),
  (3, 'promo',  'opencode-go/ox-alpha-free', 1);
