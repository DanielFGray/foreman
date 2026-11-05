/**
 * Behaviour of the in-process `Tasks` store.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Option } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAt } from "./connection.ts";
import { Tasks } from "./store.ts";

const dir = mkdtempSync(join(tmpdir(), "tasks-store-"));
const file = join(dir, "tasks.db");
const ids: Record<string, string> = {};

const withTasks = <A, E>(use: (tasks: Tasks["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* Tasks);
    }).pipe(Effect.provide(Tasks.layerAt(file))),
  );

beforeAll(async () => {
  await Effect.runPromise(Effect.void.pipe(Effect.provide(connectionAt(file))));
  await withTasks((tasks) =>
    Effect.gen(function* () {
      ids.epic = yield* tasks.add({ title: "Epic", project: "demo", type: "epic" });
      ids.first = yield* tasks.add({
        title: "First",
        project: "demo",
        parent: ids.epic,
        priority: 1,
      });
      ids.second = yield* tasks.add({
        title: "Second",
        project: "demo",
        parent: ids.epic,
        labels: ["bug"],
      });
      ids.blocked = yield* tasks.add({ title: "Blocked", project: "demo", priority: 1 });
      yield* tasks.block(ids.first!, ids.blocked!);
      ids.question = yield* tasks.add({ title: "Question", project: "demo", labels: ["question"] });
      ids.other = yield* tasks.add({
        title: "Other project",
        project: "elsewhere",
        labels: ["feature"],
      });
      ids.working = yield* tasks.add({ title: "Working", project: "demo" });
      yield* tasks.send(ids.working!, "start");
      yield* tasks.label(ids.working!, "by:cheap");
      yield* tasks.log(ids.working!, "started on cheap");
      ids.draft = yield* tasks.add({ title: "Draft", project: "demo", status: "draft" });
    }),
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("reads", () => {
  test("ready returns unblocked open work, ranked", async () => {
    for (const project of ["demo", "elsewhere"]) {
      const ready = await withTasks((tasks) => tasks.ready(project));
      expect(ready.length).toBeGreaterThan(0);
      expect(ready.every((item) => item.project === project)).toBe(true);
      expect(ready.every((item) => item.status === "open")).toBe(true);
    }
    const demo = await withTasks((tasks) => tasks.ready("demo"));
    expect(demo.map((item) => item.id)).not.toContain(ids.blocked);
    expect(demo.map((item) => item.id)).not.toContain(ids.working);
  });

  test("get returns status, labels, parent; dependencies and logs sit beside it", async () => {
    const actual = await withTasks((tasks) =>
      Effect.all({
        item: tasks.get(ids.working!),
        dependencies: tasks.dependencies(ids.blocked!),
        logs: tasks.logs(ids.working!),
      }),
    );
    expect(Option.isSome(actual.item)).toBe(true);
    if (Option.isNone(actual.item)) return;
    expect(actual.item.value.status).toBe("in_progress");
    expect(actual.item.value.labels).toEqual(["by:cheap"]);
    expect(actual.item.value.parent).toEqual(Option.none());
    expect(actual.dependencies).toEqual([ids.first!]);
    expect(actual.logs.map((entry) => entry.message)).toEqual(["started on cheap"]);
  });

  test("list narrows by project, status, parent and type", async () => {
    const cases = [
      { project: "demo" },
      { status: "in_progress" as const },
      { parent: ids.epic! },
      { project: "demo", type: "task" as const, status: "open" as const },
    ];
    for (const filter of cases) {
      const items = await withTasks((tasks) => tasks.list(filter));
      expect(items.length).toBeGreaterThan(0);
      if ("project" in filter)
        expect(items.every((item) => item.project === filter.project)).toBe(true);
      if ("status" in filter)
        expect(items.every((item) => item.status === filter.status)).toBe(true);
      if ("parent" in filter)
        expect(items.every((item) => Option.getOrUndefined(item.parent) === filter.parent)).toBe(
          true,
        );
      if ("type" in filter) expect(items.every((item) => item.type === filter.type)).toBe(true);
    }
  });
});

describe("writes", () => {
  test("start, open and done move status", async () => {
    await withTasks((tasks) =>
      tasks
        .send(ids.first!, "start")
        .pipe(
          Effect.andThen(tasks.send(ids.first!, "open")),
          Effect.andThen(tasks.send(ids.second!, "done")),
        ),
    );
    const after = await withTasks((tasks) =>
      Effect.all({
        first: tasks.get(ids.first!),
        second: tasks.get(ids.second!),
      }),
    );
    expect(Option.getOrThrow(after.first).status).toBe("open");
    expect(Option.getOrThrow(after.second).status).toBe("done");
  });

  test("label and unlabel create the label in the item's project", async () => {
    await withTasks((tasks) =>
      tasks
        .label(ids.other!, "failed-by:cheap")
        .pipe(
          Effect.andThen(tasks.label(ids.first!, "failed-by:cheap")),
          Effect.andThen(tasks.unlabel(ids.working!, "by:cheap")),
        ),
    );
    const after = await withTasks((tasks) =>
      Effect.all({
        other: tasks.get(ids.other!),
        first: tasks.get(ids.first!),
        working: tasks.get(ids.working!),
      }),
    );
    expect(Option.getOrThrow(after.other).labels).toContain("failed-by:cheap");
    expect(Option.getOrThrow(after.first).labels).toContain("failed-by:cheap");
    expect(Option.getOrThrow(after.working).labels).not.toContain("by:cheap");
  });

  test("add inserts the item, its labels and its project", async () => {
    const id = await withTasks((tasks) =>
      tasks.add({
        title: "Added",
        project: "fresh",
        description: "body",
        priority: 1,
        parent: ids.epic!,
        labels: ["bug"],
      }),
    );
    const item = Option.getOrThrow(await withTasks((tasks) => tasks.get(id)));
    expect(item).toMatchObject({
      id,
      title: "Added",
      project: "fresh",
      description: "body",
      priority: 1,
      labels: ["bug"],
    });
    expect(item.parent).toEqual(Option.some(ids.epic!));
    const sqlite = new Database(file, { readonly: true });
    try {
      expect(sqlite.query("SELECT name FROM projects WHERE name = 'fresh'").all()).toEqual([
        { name: "fresh" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  test("log appends a line", async () => {
    await withTasks((tasks) => tasks.log(ids.first!, "a line"));
    const logs = await withTasks((tasks) => tasks.logs(ids.first!));
    expect(logs.map((entry) => entry.message)).toContain("a line");
  });
});

describe("refusals", () => {
  test("start from in_progress is refused", async () => {
    const refused = await withTasks((tasks) => tasks.send(ids.working!, "start").pipe(Effect.flip));
    expect(refused).toMatchObject({
      _tag: "TaskError",
      detail: "cannot start an item that is in_progress",
    });
  });

  test("an epic's status is derived, so only done and cancel set it", async () => {
    const refused = await withTasks((tasks) => tasks.send(ids.epic!, "start").pipe(Effect.flip));
    expect(refused).toMatchObject({
      _tag: "TaskError",
      detail: expect.stringContaining("epic status is derived from children"),
    });
  });
});

describe("the migrator", () => {
  test("creates the task tables on an empty file", async () => {
    const made = mkdtempSync(join(tmpdir(), "tasks-schema-"));
    try {
      const path = join(made, "fresh.db");
      await Effect.runPromise(Effect.void.pipe(Effect.provide(connectionAt(path))));
      const sqlite = new Database(path, { readonly: true });
      try {
        const tables = sqlite
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all()
          .map((row) => row.name);
        expect(tables).toContain("items");
        expect(tables).toContain("labels");
        expect(tables).toContain("logs");
        expect(tables).toContain("deps");
        expect(tables).toContain("projects");
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(made, { recursive: true, force: true });
    }
  });

  test("drops the learnings a store from prog holds", async () => {
    const made = mkdtempSync(join(tmpdir(), "tasks-schema-"));
    try {
      const path = join(made, "prog.db");
      const before = new Database(path);
      before.exec(`
        CREATE TABLE concepts (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
        CREATE TABLE learnings (id TEXT PRIMARY KEY,
          task_id TEXT REFERENCES items(id) ON DELETE SET NULL,
          summary TEXT NOT NULL, detail TEXT);
        CREATE TABLE learning_concepts (learning_id TEXT REFERENCES learnings(id),
          concept_id TEXT REFERENCES concepts(id), PRIMARY KEY (learning_id, concept_id));
        CREATE TABLE learning_sources (id TEXT PRIMARY KEY,
          learning_id TEXT NOT NULL REFERENCES learnings(id) ON DELETE CASCADE, path TEXT NOT NULL);
        CREATE TABLE learning_relations (
          source_id TEXT NOT NULL REFERENCES learnings(id) ON DELETE CASCADE,
          target_id TEXT NOT NULL REFERENCES learnings(id) ON DELETE CASCADE,
          kind TEXT NOT NULL, PRIMARY KEY (source_id, target_id, kind));
        CREATE VIRTUAL TABLE learnings_fts USING fts5(summary, detail,
          content='learnings', content_rowid='rowid');
        CREATE TRIGGER learnings_ai AFTER INSERT ON learnings BEGIN
          INSERT INTO learnings_fts(rowid, summary, detail) VALUES (NEW.rowid, NEW.summary, NEW.detail);
        END;
        INSERT INTO concepts VALUES ('c-1', 'store');
        INSERT INTO learnings VALUES ('l-1', NULL, 'a learning', NULL);
        INSERT INTO learnings VALUES ('l-2', NULL, 'a later learning', NULL);
        INSERT INTO learning_concepts VALUES ('l-1', 'c-1');
        INSERT INTO learning_sources VALUES ('s-1', 'l-1', 'src/a.ts');
        INSERT INTO learning_relations VALUES ('l-2', 'l-1', 'supersedes');
      `);
      before.close();
      await Effect.runPromise(Effect.void.pipe(Effect.provide(connectionAt(path))));
      const sqlite = new Database(path, { readonly: true });
      try {
        const left = sqlite
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master WHERE name LIKE '%learning%' OR name LIKE '%concept%'`,
          )
          .all();
        expect(left).toEqual([]);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(made, { recursive: true, force: true });
    }
  });
});
