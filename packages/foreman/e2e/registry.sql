-- Seed rows for the end-to-end rig's scratch task store: three rungs, over two
-- different models so a probe run exercises a climb, and one promotional rung so
-- the `unmetered` flag has a row to survive the round trip. The tables come from
-- the tasks package's migration; this file holds data only, and is run after a
-- foreman command has opened the store once (see e2e/README.md).
--
--   sqlite3 "$TASKS_DB" < e2e/registry.sql
INSERT INTO pools(pool, harness, provider_default) VALUES
  ('OpenCode Zen', 'opencode', 'opencode'),
  ('OpenCode Go', 'opencode', 'opencode-go');
INSERT INTO models(model, provider, pool, harness, limit_scope) VALUES
  ('opencode/deepseek-v4-pro', 'opencode', 'OpenCode Zen', 'opencode', 'pool'),
  ('opencode/claude-sonnet-5', 'opencode', 'OpenCode Zen', 'opencode', 'pool'),
  ('opencode-go/ox-alpha-free', 'opencode-go', 'OpenCode Go', 'opencode', 'pool');
INSERT INTO ladder(rank, level, rung, model, thinking, unmetered) VALUES
  (1, 1, 'cheap',  'opencode/deepseek-v4-pro', 'medium', 0),
  (2, 2, 'strong', 'opencode/claude-sonnet-5', 'medium', 0),
  (3, 3, 'promo',  'opencode-go/ox-alpha-free', 'medium', 1);
