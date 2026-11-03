import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyCommand } from "./policy-command.ts";

const folder = mkdtempSync(join(tmpdir(), "foreman-policy-command-"));
const path = join(folder, "policy.json");
process.env["FOREMAN_POLICY"] = path;
afterAll(() => rmSync(folder, { recursive: true, force: true }));
beforeEach(() => rmSync(path, { force: true }));

const run = (...args: ReadonlyArray<string>) =>
  Effect.runPromise(
    Command.runWith(policyCommand, { version: "test" })(args).pipe(
      Effect.provide(BunServices.layer),
    ),
  );
const written = () => JSON.parse(readFileSync(path, "utf8"));

describe("foreman policy --project", () => {
  test("set writes one project's step and leaves the fleet default alone", async () => {
    await run("set", "author", "on", "--project", "amux");
    expect(written().projects).toEqual({ amux: { steps: { author: "on" } } });
    expect(written().default.author).toBe("off");
  });

  test("set without --project still writes the fleet default", async () => {
    await run("set", "author", "ask");
    expect(written().default.author).toBe("ask");
    expect(written().projects).toEqual({});
  });

  test("pause and resume --project touch only that project", async () => {
    await run("pause", "--project", "amux");
    expect(written().paused).toBe(false);
    expect(written().projects).toEqual({ amux: { paused: true } });
    await run("resume", "--project", "amux");
    expect(written().projects).toEqual({});
  });

  test("pause without --project is the global pause", async () => {
    await run("pause");
    expect(written().paused).toBe(true);
    await run("resume");
    expect(written().paused).toBe(false);
  });

  test("clear drops the project's entry and keeps the others", async () => {
    await run("set", "land", "ask", "--project", "amux");
    await run("pause", "--project", "dfg.rocks");
    await run("clear", "--project", "amux");
    expect(written().projects).toEqual({ "dfg.rocks": { paused: true } });
  });

  test("show lists the projects' overrides", async () => {
    await run("set", "review", "on", "--project", "amux");
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(String(line));
    try {
      await run("show");
    } finally {
      console.log = original;
    }
    expect(JSON.parse(lines.join("\n")).projects).toEqual({ amux: { steps: { review: "on" } } });
  });
});

describe("foreman policy tracker", () => {
  test("writes the choice and keeps the project's other settings", async () => {
    await run("set", "author", "on", "--project", "amux");
    await run("tracker", "github", "--project", "amux");
    expect(written().projects).toEqual({ amux: { steps: { author: "on" }, tracker: "github" } });
  });

  test("prog is the default, so choosing it drops the key", async () => {
    await run("tracker", "github", "--project", "amux");
    await run("tracker", "prog", "--project", "amux");
    expect(written().projects).toEqual({});
  });

  test("linear needs the Linear team and project, and writes nothing without them", async () => {
    await run("tracker", "github", "--project", "amux");
    const refused = await run("tracker", "linear", "--project", "amux").then(
      () => undefined,
      (error: unknown) => String(error),
    );
    expect(refused).toContain("--team <key> and --linear-project <name>");
    expect(written().projects).toEqual({ amux: { tracker: "github" } });
  });

  test("clear keeps the tracker", async () => {
    await run("tracker", "github", "--project", "amux");
    await run("set", "land", "ask", "--project", "amux");
    await run("clear", "--project", "amux");
    expect(written().projects).toEqual({ amux: { tracker: "github" } });
  });
});
