import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchArguments } from "./herdr.ts";
import { parseRows, readLadder, readRows, renderRows, writeRows } from "./registry.ts";

const scratch = () => {
  const path = join(mkdtempSync(join(tmpdir(), "foreman-registry-")), "registry.db");
  const db = new Database(path);
  db.exec(readFileSync(join(import.meta.dir, "..", "e2e", "registry.sql"), "utf8"));
  db.close();
  return path;
};

describe("the registry ladder", () => {
  test("reads rungs cheapest first with the model's harness and thinking level", () => {
    const ladder = readLadder(scratch());
    expect(ladder.map((rung) => rung.name)).toEqual(["cheap", "strong", "promo"]);
    expect(ladder[0]).toMatchObject({ harness: "opencode", thinking: "medium" });
  });

  test("an edit round-trips through its text, and moving a block re-ranks it", () => {
    const path = scratch();
    const rows = parseRows(renderRows(readRows(path)));
    const [first, ...rest] = rows;
    writeRows(path, [...rest, first!]);
    expect(readRows(path).map((row) => row.rung)).toEqual(["strong", "promo", "cheap"]);
    expect(readRows(path)[1]?.unmetered).toBe(true);
  });

  test("a bad edit changes nothing", () => {
    const path = scratch();
    const rows = readRows(path);
    expect(() => writeRows(path, [{ ...rows[0]!, model: "no/such-model" }])).toThrow(
      /no row in the models table/,
    );
    expect(() =>
      writeRows(
        path,
        rows.map((row) => ({ ...row, enabled: false })),
      ),
    ).toThrow(/every rung is disabled/);
    expect(() => writeRows(path, [rows[0]!, rows[0]!])).toThrow(/appears twice/);
    expect(readRows(path).map((row) => row.rung)).toEqual(["cheap", "strong", "promo"]);
  });
});

describe("launchArguments", () => {
  test("spells the thinking level the way each harness takes it", () => {
    const model = "m";
    expect(launchArguments({ kind: "claude", model, thinking: "low" })).toEqual([
      "--",
      "--model",
      "m",
      "--effort",
      "low",
    ]);
    expect(launchArguments({ kind: "codex", model, thinking: "low" })).toEqual([
      "--",
      "--model",
      "m",
      "-c",
      "model_reasoning_effort=low",
    ]);
    expect(launchArguments({ kind: "pi", model, thinking: "medium" })).toEqual([
      "--",
      "--model",
      "m",
      "--thinking",
      "medium",
    ]);
  });

  test("passes no flag for a level the harness picks or cannot take", () => {
    expect(launchArguments({ kind: "cursor", model: undefined, thinking: "auto" })).toEqual([]);
    expect(launchArguments({ kind: "claude", model: undefined, thinking: undefined })).toEqual([]);
  });
});
