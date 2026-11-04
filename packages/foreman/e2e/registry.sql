-- Seed rows for the end-to-end rig's scratch task store: three rungs, over two
-- different models so a probe run exercises a climb, and one promotional rung so
-- the `unmetered` flag has a row to survive the round trip. The tables come from
-- the tasks package's migration; this file holds data only, and is run after a
-- foreman command has opened the store once (see e2e/README.md).
--
--   sqlite3 "$PROG_DB" < e2e/registry.sql
INSERT INTO pools(pool, harness, provider_default) VALUES
  ('OpenCode Zen', 'opencode', 'opencode'),
  ('OpenCode Go', 'opencode', 'opencode-go');
INSERT INTO models(model, provider, pool, harness, limit_scope, thinking) VALUES
  ('opencode/deepseek-v4-pro', 'opencode', 'OpenCode Zen', 'opencode', 'pool', 'medium'),
  ('opencode/claude-sonnet-5', 'opencode', 'OpenCode Zen', 'opencode', 'pool', 'medium'),
  ('opencode-go/ox-alpha-free', 'opencode-go', 'OpenCode Go', 'opencode', 'pool', 'medium');
INSERT INTO ladder(rank, level, rung, model, unmetered) VALUES
  (1, 1, 'cheap',  'opencode/deepseek-v4-pro', 0),
  (2, 2, 'strong', 'opencode/claude-sonnet-5', 0),
  (3, 3, 'promo',  'opencode-go/ox-alpha-free', 1);
