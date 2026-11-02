import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The task tables the Go `prog` creates, as it leaves them after its last
 * migration, minus the learning tables the `tasks` commands never touch.
 * A test cannot ask Go for them: `tasks` must run where `prog` is not installed.
 */
const GO_TASK_TABLES = `
  CREATE TABLE items (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'open', priority INTEGER DEFAULT 2,
    parent_id TEXT REFERENCES items(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    definition_of_done TEXT);
  CREATE TABLE deps (
    item_id TEXT REFERENCES items(id), depends_on TEXT REFERENCES items(id),
    PRIMARY KEY (item_id, depends_on));
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY, item_id TEXT REFERENCES items(id), message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE projects (
    name TEXT PRIMARY KEY, description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE labels (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, project TEXT NOT NULL, color TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (name, project));
  CREATE TABLE item_labels (
    item_id TEXT REFERENCES items(id), label_id TEXT REFERENCES labels(id),
    PRIMARY KEY (item_id, label_id));
`;

/** A store file with the Go task tables and no rows; `cleanup` removes it. */
export const scratchTaskStore = () => {
  const directory = mkdtempSync(join(tmpdir(), "tasks-cli-"));
  const file = join(directory, "prog.db");
  const database = new Database(file);
  database.exec(GO_TASK_TABLES);
  database.close();
  return { file, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
};
