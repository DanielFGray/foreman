import { afterAll, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Stdio, Stream } from "effect";
import { Command } from "effect/cli";
import { connectionAt } from "../connection.ts";
import { Tasks } from "../store.ts";
import { tasksCommand } from "./commands.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A store file that does not exist yet: `tasks` makes it by running the migrations. */
const scratch = (() => {
  const directory = mkdtempSync(join(tmpdir(), "tasks-cli-"));
  return {
    file: join(directory, "prog.db"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
})();
afterAll(scratch.cleanup);

const services = (stdin?: string) =>
  Layer.mergeAll(
    BunServices.layer,
    stdin === undefined
      ? Layer.empty
      : Stdio.layerTest({ stdin: Stream.make(new TextEncoder().encode(stdin)) }),
    Tasks.layerSql.pipe(Layer.provideMerge(connectionAt(scratch.file))),
  );

const runCommand = (args: ReadonlyArray<string>, stdin?: string) =>
  Command.runWith(tasksCommand, { version: "test" })(args).pipe(Effect.provide(services(stdin)));

/** What a command prints. */
const run = async (args: ReadonlyArray<string>, stdin?: string): Promise<string> => {
  const printed: Array<string> = [];
  const original = console.log;
  console.log = (...parts: Array<unknown>) => void printed.push(parts.join(" "));
  try {
    await Effect.runPromise(runCommand(args, stdin));
  } finally {
    console.log = original;
  }
  return printed.join("\n");
};

/** The one-line message of the error a refused command fails with. */
const refusal = (args: ReadonlyArray<string>) =>
  Effect.runPromise(
    runCommand(args).pipe(
      Effect.flip,
      Effect.map((error) =>
        "detail" in error ? `${String(error.id)}: ${error.detail}` : String(error),
      ),
    ),
  );

const created = async (...args: ReadonlyArray<string>): Promise<string> =>
  /\b(?:ts|ep)-[0-9a-f]{6}\b/.exec(await run(["add", ...args]))![0];

describe("tasks add, show, list and ready", () => {
  test("a new task shows with its fields and is listed and ready", async () => {
    const id = await created(
      "Write it",
      "-p",
      "a",
      "-d",
      "the body",
      "--dod",
      "it passes",
      "-l",
      "bug",
      "-l",
      "urgent",
      "--priority",
      "1",
    );
    const shown = await run(["show", id]);
    for (const expected of [
      `ID:          ${id}`,
      "Project:     a",
      "Status:      open",
      "Priority:    1",
      "bug, urgent",
      "the body",
      "it passes",
    ]) {
      expect(shown).toContain(expected);
    }
    expect((await run(["list", "-p", "a"])).split(/\s+/).join(" ")).toBe(
      `${id} open 1 a [bug] [urgent] Write it`,
    );
    expect(await run(["ready", "-p", "a"])).toContain(id);
    expect(await run(["list", "-p", "a", "-l", "bug", "-l", "nope"])).toBe("No items");
  });

  test("a proposal and a question are not ready; an epic's child shows its parent", async () => {
    const proposal = await created("Idea", "-p", "b", "--status", "proposed");
    const question = await created("Which?", "-p", "b", "-l", "question");
    const epic = await created("Big", "-p", "b", "-e");
    const child = await created("Part", "-p", "b", "--parent", epic);
    const ready = await run(["ready", "-p", "b"]);
    expect(ready).toContain(child);
    expect(ready).not.toContain(proposal);
    expect(ready).not.toContain(question);
    expect(await run(["show", child])).toContain(`Parent:      ${epic}`);
  });

  test("show --json prints one object with the children, dependencies and log", async () => {
    const epic = await created("Whole", "-p", "c", "-e", "-d", "the plan");
    const first = await created("First", "-p", "c", "--parent", epic);
    const second = await created("Second", "-p", "c", "--parent", epic);
    await run(["blocks", first, second]);
    await run(["log", second, "began"]);
    const shownEpic = JSON.parse(await run(["show", epic, "--json"]));
    expect(shownEpic).toMatchObject({ id: epic, description: "the plan", type: "epic" });
    expect([...shownEpic.children].sort()).toEqual([first, second].sort());
    const shown = JSON.parse(await run(["show", second, "--json"]));
    expect(shown).toMatchObject({
      parent: epic,
      dependencies: [first],
      dependents: [],
      children: [],
    });
    expect(shown.logs.map((log: { message: string }) => log.message)).toEqual(["began"]);
  });

  test("a bad parent or priority is refused in one line", async () => {
    const task = await created("Plain", "-p", "c");
    expect(await refusal(["add", "x", "-p", "c", "--parent", task])).toContain(
      "parent must be an epic",
    );
    expect(await refusal(["add", "x", "-p", "c", "--priority", "7"])).toContain(
      "invalid priority 7",
    );
  });
});

describe("tasks status changes", () => {
  test("start, review and done follow the task machine", async () => {
    const id = await created("Flow", "-p", "d");
    expect(await run(["start", id])).toBe(`Started ${id}`);
    expect(await run(["show", id])).toContain("Status:      in_progress");
    await run(["review", id]);
    await run(["done", id]);
    expect(await run(["list", "-p", "d", "--status", "done"])).toContain(id);
    await run(["open", id]);
    expect(await run(["list", "-p", "d", "--status", "open"])).toContain(id);
  });

  test("a refused move names the status and the command", async () => {
    const id = await created("Stuck", "-p", "d");
    await run(["start", id]);
    await run(["done", id]);
    expect(await refusal(["start", id])).toBe(`${id}: cannot start an item that is done`);
    expect(await refusal(["start", "ts-000000"])).toBe("ts-000000: item not found: ts-000000");
  });

  test("propose, draft and cancel move an open task, and cancel logs its reason", async () => {
    const id = await created("Maybe", "-p", "d");
    await run(["propose", id]);
    expect(await run(["show", id])).toContain("Status:      proposed");
    await run(["draft", id]);
    expect(await run(["show", id])).toContain("Status:      draft");
    await run(["cancel", id, "no", "longer", "needed"]);
    const shown = await run(["show", id]);
    expect(shown).toContain("Status:      canceled");
    expect(shown).toContain("Canceled: no longer needed");
  });
});

describe("tasks text commands", () => {
  test("desc, append, edit and log change the text, and - reads stdin", async () => {
    const id = await created("Words", "-p", "e", "-d", "first");
    await run(["append", id, "second"]);
    expect(await run(["show", id])).toContain("first\nsecond");
    await run(["desc", id, "-"], "replaced\nover two lines\n");
    expect(await run(["show", id])).toContain("replaced\nover two lines");
    await run(["edit", id, "--title", "New title", "--dod", "-"], "check it");
    const shown = await run(["show", id]);
    expect(shown).toContain("Title:       New title");
    expect(shown).toContain("check it");
    await run(["log", id, "-"], "a result");
    expect(await run(["show", id])).toContain("a result");
    await run(["edit", id, "--dod", ""]);
    expect(await run(["show", id])).not.toContain("Definition of Done");
    expect(await refusal(["edit", id])).toContain("nothing to edit");
  });
});

describe("tasks labels, priority and parent", () => {
  test("label and unlabel change the list; priority and parent change the task", async () => {
    const epic = await created("Group", "-p", "f", "-e");
    const id = await created("Tagged", "-p", "f");
    await run(["label", id, "bug"]);
    expect(await run(["list", "-p", "f", "-l", "bug"])).toContain(id);
    await run(["unlabel", id, "bug"]);
    expect(await run(["list", "-p", "f", "-l", "bug"])).toBe("No items");
    expect(await refusal(["unlabel", id, "bug"])).toContain("does not have label");
    await run(["priority", id, "3"]);
    await run(["parent", id, epic]);
    const shown = await run(["show", id]);
    expect(shown).toContain("Priority:    3");
    expect(shown).toContain(`Parent:      ${epic}`);
    expect(await refusal(["parent", id, id])).toContain("parent must be an epic");
  });
});

describe("tasks dependencies", () => {
  test("blocks holds a task back, shows both ways, and draws in the graph", async () => {
    const first = await created("First", "-p", "g");
    const second = await created("Second", "-p", "g");
    await run(["blocks", first, second]);
    expect(await run(["ready", "-p", "g"])).not.toContain(second);
    expect(await run(["show", second])).toContain(`Dependencies:\n  - ${first}`);
    expect(await run(["show", first])).toContain(`Blocks:\n  - ${second}`);
    const graph = await run(["graph", "-p", "g"]);
    expect(graph).toContain("flowchart");
    expect(graph).toContain(`${first} open - First`);
    await run(["start", first]);
    await run(["done", first]);
    expect(await run(["ready", "-p", "g"])).toContain(second);
    await run(["unblocks", first, second]);
    expect(await run(["show", second])).not.toContain("Dependencies");
  });

  test("an edge that makes a cycle is refused in one line", async () => {
    const one = await created("One", "-p", "h");
    const two = await created("Two", "-p", "h");
    const three = await created("Three", "-p", "h");
    await run(["blocks", one, two]);
    await run(["blocks", two, three]);
    const message = await refusal(["blocks", three, one]);
    expect(message).toContain("that makes a cycle");
    expect(message).not.toContain("\n");
    expect(await refusal(["blocks", one, one])).toContain("that makes a cycle");
  });
});

describe("tasks status and prime", () => {
  test("status counts tasks by status, and prime prints the workflow", async () => {
    await created("Counted", "-p", "i");
    expect(await run(["status", "-p", "i"])).toContain("Tasks: 1 (open 1)");
    expect(await run(["prime"])).toContain("tasks ready");
  });
});

describe("a store that does not exist yet", () => {
  test("add makes it and the task shows", async () => {
    const id = await created("First task", "-p", "fresh");
    expect(await run(["ready", "-p", "fresh"])).toContain(id);
  });
});

describe("tasks as a drop-in for prog", () => {
  test("add prints the bare id, so $(tasks add ...) holds it", async () => {
    const printed = await run(["add", "Scripted", "-p", "j"]);
    expect(printed).toMatch(/^ts-[0-9a-f]{6}$/);
    expect(await run(["add", "Group", "-p", "j", "-e"])).toMatch(/^ep-[0-9a-f]{6}$/);
  });

  test("-p works before the subcommand as well as after it", async () => {
    const id = await created("Scoped", "-p", "k");
    expect(await run(["-p", "k", "list"])).toContain(id);
    expect(await run(["-p", "k", "ready"])).toContain(id);
    expect(await run(["list", "-p", "other"])).toBe("No items");
    const viaRoot = await run(["-p", "k", "add", "Later"]);
    expect(await run(["show", viaRoot])).toContain("Project:     k");
    expect(await refusal(["add", "No project"])).toBe("add: project is required (-p)");
  });

  test("add reads --desc and --dod from stdin, and --blocks makes the new task a prerequisite", async () => {
    const waiting = await created("Waiting", "-p", "l");
    const id = await created("Needed first", "-p", "l", "--desc", "-", "--blocks", waiting);
    expect(await run(["ready", "-p", "l"])).not.toContain(waiting);
    expect(await run(["show", waiting])).toContain(`Dependencies:\n  - ${id}`);
    expect(await refusal(["add", "x", "-p", "l", "--blocks", "ts-000000"])).toContain(
      "item not found",
    );
    const piped = await run(["add", "Piped", "-p", "l", "-d", "-"], "from stdin\n");
    expect(await run(["show", piped])).toContain("from stdin");
  });

  test("list and ready print JSON with prog's field names", async () => {
    const epic = await created("Parent", "-p", "m", "-e");
    const child = await created("Child", "-p", "m", "--parent", epic, "-l", "bug");
    const listed = JSON.parse(await run(["list", "-p", "m", "--parent", epic, "--json"]));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: child,
      type: "task",
      status: "open",
      parent: epic,
      labels: ["bug"],
    });
    expect(listed[0]).toHaveProperty("last_activity_at");
    expect(
      JSON.parse(await run(["ready", "-p", "m", "--json"])).map((x: { id: string }) => x.id),
    ).toContain(child);
    expect(JSON.parse(await run(["list", "-p", "m", "--type", "epic", "--json"]))).toHaveLength(1);
  });

  test("status lists open questions and counts what is ready", async () => {
    const question = await created("Which way?", "-p", "n", "-l", "question");
    const shown = await run(["status", "-p", "n"]);
    expect(shown).toContain("Questions (open decisions):");
    expect(shown).toContain(question);
    expect(shown).not.toContain("Ready");
  });
});
