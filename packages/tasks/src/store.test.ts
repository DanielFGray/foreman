/**
 * `Tasks` against the Go `prog` it ports, on two copies of one database.
 *
 * Every case runs the Go command on one copy and the `Tasks` call on the other,
 * then compares what each answered and the rows each left. The fixture is built
 * by Go `prog` itself, so it holds exactly the layouts Go writes. Skipped where
 * no `prog` is installed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Status } from "./item.ts";
import { connectionAt } from "./connection.ts";
import { Tasks } from "./store.ts";

const byText = (left: string, right: string) => left.localeCompare(right);
const hasProg = Bun.which("prog") !== null;
const dir = mkdtempSync(join(tmpdir(), "tasks-diff-"));
const fixture = join(dir, "fixture.db");
const ids: Record<string, string> = {};

const prog = (db: string, ...args: Array<string>): string => {
  const run = Bun.spawnSync(["prog", ...args], { env: { ...process.env, PROG_DB: db } });
  if (run.exitCode !== 0) throw new Error(`prog ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString();
};

const progJson = <A>(db: string, ...args: Array<string>): A =>
  JSON.parse(prog(db, ...args, "--json")) as A;

const added = (db: string, ...args: Array<string>): string => {
  const id = /\b(ts|ep)-[0-9a-f]{6}\b/.exec(prog(db, "add", ...args))?.[0];
  if (id === undefined) throw new Error(`prog add ${args.join(" ")} printed no id`);
  return id;
};

/** A fresh pair of copies of the fixture: one for Go, one for `Tasks`. */
let pair = 0;
const copies = () => {
  pair++;
  const go = join(dir, `go-${pair}.db`);
  const ts = join(dir, `ts-${pair}.db`);
  copyFileSync(fixture, go);
  copyFileSync(fixture, ts);
  return { go, ts };
};

const withTasks = <A, E>(db: string, use: (tasks: Tasks["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* Tasks);
    }).pipe(Effect.provide(Tasks.layerAt(db))),
  );

/** The rows a command can change, without ids or times it generates. */
const rows = (db: string) => {
  const sqlite = new Database(db, { readonly: true });
  try {
    return {
      items: sqlite
        .query(
          "SELECT id, project, type, title, status, priority, parent_id FROM items ORDER BY id",
        )
        .all(),
      labels: sqlite
        .query(
          "SELECT il.item_id, l.name, l.project FROM item_labels il JOIN labels l ON l.id = il.label_id ORDER BY 1, 2",
        )
        .all(),
      logs: sqlite.query("SELECT item_id, message FROM logs ORDER BY item_id, id").all(),
      deps: sqlite.query("SELECT item_id, depends_on FROM deps ORDER BY 1, 2").all(),
    };
  } finally {
    sqlite.close();
  }
};

beforeAll(() => {
  if (!hasProg) return;
  prog(fixture, "init");
  ids.epic = added(fixture, "Epic", "-p", "demo", "-e");
  ids.first = added(fixture, "First", "-p", "demo", "--parent", ids.epic, "--priority", "1");
  ids.second = added(fixture, "Second", "-p", "demo", "--parent", ids.epic, "-l", "bug");
  ids.blocked = added(fixture, "Blocked", "-p", "demo", "--priority", "1");
  prog(fixture, "blocks", ids.first, ids.blocked);
  ids.question = added(fixture, "Question", "-p", "demo", "-l", "question");
  ids.other = added(fixture, "Other project", "-p", "elsewhere", "-l", "feature");
  ids.working = added(fixture, "Working", "-p", "demo");
  prog(fixture, "start", ids.working);
  prog(fixture, "label", ids.working, "by:cheap");
  prog(fixture, "log", ids.working, "started on cheap");
  ids.draft = added(fixture, "Draft", "-p", "demo", "--status", "draft");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!hasProg)("reads match prog", () => {
  test("ready: the same tasks, in the same order", async () => {
    const { go, ts } = copies();
    for (const project of ["demo", "elsewhere"]) {
      const expected = progJson<Array<{ id: string }>>(go, "ready", "-p", project).map(
        (item) => item.id,
      );
      const actual = await withTasks(ts, (tasks) => tasks.ready(project));
      expect(expected.length).toBeGreaterThan(0);
      expect(actual.map((item) => item.id)).toEqual(expected);
    }
  });

  test("show: status, labels, parent, dependencies and logs", async () => {
    const { go, ts } = copies();
    for (const id of Object.values(ids)) {
      const expected = progJson<{
        status: Status;
        labels: Array<string>;
        parent: string | null;
        dependencies: Array<string>;
        logs: Array<{ message: string }>;
        created_at: string;
        last_activity_at: string;
      }>(go, "show", id);
      const actual = await withTasks(ts, (tasks) =>
        Effect.all({
          item: tasks
            .get(id)
            .pipe(
              Effect.map((found) => found.pipe((o) => (o._tag === "Some" ? o.value : undefined))),
            ),
          dependencies: tasks.dependencies(id),
          logs: tasks.logs(id),
        }),
      );
      expect({
        status: actual.item?.status,
        labels: actual.item?.labels,
        parent: actual.item?.parent ?? null,
        dependencies: actual.dependencies,
        logs: actual.logs.map((entry) => entry.message),
        created_at: actual.item?.createdAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
        last_activity_at: actual.item?.lastActivityAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
      }).toEqual({
        status: expected.status,
        labels: expected.labels,
        parent: expected.parent,
        dependencies: expected.dependencies,
        logs: expected.logs.map((entry) => entry.message),
        created_at: expected.created_at,
        last_activity_at: expected.last_activity_at,
      });
    }
  });

  test("list: the same items under each filter", async () => {
    const { go, ts } = copies();
    const cases: Array<[Array<string>, Parameters<Tasks["Service"]["list"]>[0]]> = [
      [["-p", "demo"], { project: "demo" }],
      [["--status", "in_progress"], { status: "in_progress" }],
      [["--parent", ids.epic!], { parent: ids.epic! }],
      [
        ["-p", "demo", "--type", "task", "--status", "open"],
        { project: "demo", type: "task", status: "open" },
      ],
    ];
    for (const [args, filter] of cases) {
      const expected = progJson<Array<{ id: string; status: string }>>(go, "list", ...args);
      const actual = await withTasks(ts, (tasks) => tasks.list(filter));
      expect(expected.length).toBeGreaterThan(0);
      expect(actual.map((item) => `${item.id} ${item.status}`).sort(byText)).toEqual(
        expected.map((item) => `${item.id} ${item.status}`).sort(byText),
      );
    }
  });
});

describe.skipIf(!hasProg)("writes leave the same rows as prog", () => {
  const same = async (
    go: (db: string) => void,
    ts: (tasks: Tasks["Service"]) => Effect.Effect<unknown, unknown>,
  ) => {
    const pairOf = copies();
    go(pairOf.go);
    await withTasks(pairOf.ts, ts);
    expect(rows(pairOf.ts)).toEqual(rows(pairOf.go));
  };

  test("start, open, done", () =>
    same(
      (db) => {
        prog(db, "start", ids.first!);
        prog(db, "open", ids.first!);
        prog(db, "done", ids.second!);
      },
      (tasks) =>
        tasks
          .send(ids.first!, "start")
          .pipe(
            Effect.andThen(tasks.send(ids.first!, "open")),
            Effect.andThen(tasks.send(ids.second!, "done")),
          ),
    ));

  test("label and unlabel, creating the label in the item's project", () =>
    same(
      (db) => {
        prog(db, "label", ids.other!, "failed-by:cheap");
        prog(db, "label", ids.first!, "failed-by:cheap");
        prog(db, "unlabel", ids.working!, "by:cheap");
      },
      (tasks) =>
        tasks
          .label(ids.other!, "failed-by:cheap")
          .pipe(
            Effect.andThen(tasks.label(ids.first!, "failed-by:cheap")),
            Effect.andThen(tasks.unlabel(ids.working!, "by:cheap")),
          ),
    ));

  test("add, matched by title since ids are random", async () => {
    const { go, ts } = copies();
    prog(
      go,
      "add",
      "Added",
      "-p",
      "fresh",
      "-d",
      "body",
      "--priority",
      "1",
      "--parent",
      ids.epic!,
      "-l",
      "bug",
    );
    await withTasks(ts, (tasks) =>
      tasks.add({
        title: "Added",
        project: "fresh",
        description: "body",
        priority: 1,
        parent: ids.epic!,
        labels: ["bug"],
      }),
    );
    const added = (db: string) => {
      const sqlite = new Database(db, { readonly: true });
      try {
        return {
          item: sqlite
            .query(
              "SELECT project, type, title, description, status, priority, parent_id, substr(id, 1, 3) AS prefix FROM items WHERE title = 'Added'",
            )
            .all(),
          labels: sqlite
            .query(
              "SELECT l.name, l.project FROM items i JOIN item_labels il ON il.item_id = i.id JOIN labels l ON l.id = il.label_id WHERE i.title = 'Added'",
            )
            .all(),
          projects: sqlite.query("SELECT name FROM projects WHERE name = 'fresh'").all(),
        };
      } finally {
        sqlite.close();
      }
    };
    expect(added(go).item).toHaveLength(1);
    expect(added(ts)).toEqual(added(go));
  });

  test("log", () =>
    same(
      (db) => void prog(db, "log", ids.first!, "a line"),
      (tasks) => tasks.log(ids.first!, "a line"),
    ));
});

describe.skipIf(!hasProg)("refusals match prog", () => {
  test("start from in_progress is refused", async () => {
    const { ts } = copies();
    const refused = await withTasks(ts, (tasks) =>
      tasks.send(ids.working!, "start").pipe(Effect.flip),
    );
    expect(refused).toMatchObject({
      _tag: "TaskError",
      detail: "cannot start an item that is in_progress",
    });
  });

  test("an epic's status is derived, so only done and cancel set it", async () => {
    const { ts } = copies();
    const refused = await withTasks(ts, (tasks) =>
      tasks.send(ids.epic!, "start").pipe(Effect.flip),
    );
    expect(refused).toMatchObject({
      _tag: "TaskError",
      detail: expect.stringContaining("epic status is derived from children"),
    });
  });
});

describe.skipIf(!hasProg)("the migrator makes the schema `prog init` makes", () => {
  test("same tables, columns, indexes, triggers and schema version", async () => {
    const made = mkdtempSync(join(tmpdir(), "tasks-schema-"));
    try {
      const goFile = join(made, "go.db");
      const tsFile = join(made, "ts.db");
      prog(goFile, "init");
      await Effect.runPromise(Effect.void.pipe(Effect.provide(connectionAt(tsFile))));
      expect(schemaOf(tsFile)).toEqual(schemaOf(goFile));
    } finally {
      rmSync(made, { recursive: true, force: true });
    }
  });
});

/** Every Go-owned object in `sqlite_master` with its columns or index keys, and the schema version. */
const schemaOf = (file: string) => {
  const sqlite = new Database(file, { readonly: true });
  try {
    const objects = sqlite
      .query<{ type: string; name: string; tbl_name: string }, []>(
        `SELECT type, name, tbl_name FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'tasks_migrations%'
           AND tbl_name NOT IN (${OTHER_TABLES.map((name) => `'${name}'`).join(", ")})
         ORDER BY type, name`,
      )
      .all();
    return {
      version: sqlite.query("PRAGMA user_version").get(),
      objects: objects.map((object) => ({
        ...object,
        detail:
          object.type === "table"
            ? sqlite
                .query(
                  `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${object.name}')`,
                )
                .all()
            : object.type === "index"
              ? sqlite.query(`SELECT name FROM pragma_index_info('${object.name}')`).all()
              : null,
      })),
    };
  } finally {
    sqlite.close();
  }
};

/** The tables foreman's migrations add (`0002_registry`, `0007_charges_and_parks`, `0010_reviewers`); Go does not create them. */
const OTHER_TABLES = [
  "charges",
  "parks",
  "providers",
  "pools",
  "pool_aliases",
  "models",
  "aliases",
  "ladder",
  "reviewers",
  "prices",
  "runs",
  "defects",
  "run_cost",
  "model_summary",
  "size_summary",
  "run_identity",
  "model_status",
  "herd_roster",
];
