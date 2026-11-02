import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { addRow, parseRows, readLadder, readRows, renderRows, writeRows } from "./registry.ts";
import { withStore } from "./scratch-store.ts";

const rig = readFileSync(join(import.meta.dir, "..", "e2e", "registry.sql"), "utf8");

describe("the registry ladder", () => {
  test("reads rungs cheapest first with the model's harness and thinking level", () =>
    withStore(
      rig,
      Effect.gen(function* () {
        const ladder = yield* readLadder;
        expect(ladder.map((rung) => rung.name)).toEqual(["cheap", "strong", "promo"]);
        expect(ladder[0]).toMatchObject({ harness: "opencode", thinking: "medium" });
      }),
    ));

  test("an edit round-trips through its text, and moving a block re-ranks it", () =>
    withStore(
      rig,
      Effect.gen(function* () {
        const rows = parseRows(renderRows(yield* readRows));
        const [first, ...rest] = rows;
        yield* writeRows([...rest, first!]);
        const after = yield* readRows;
        expect(after.map((row) => row.rung)).toEqual(["strong", "promo", "cheap"]);
        expect(after[1]?.unmetered).toBe(true);
      }),
    ));

  test("a new rung goes in at its place, not on top of the ladder", () =>
    withStore(
      rig,
      Effect.gen(function* () {
        const [cheap] = yield* readRows;
        const row = { ...cheap!, rung: "new" };
        yield* addRow(row, { _tag: "Bottom" });
        expect((yield* readRows).map((r) => r.rung)).toEqual(["new", "cheap", "strong", "promo"]);
        yield* addRow({ ...row, rung: "mid" }, { _tag: "Above", rung: "cheap" });
        yield* addRow({ ...row, rung: "low" }, { _tag: "Below", rung: "promo" });
        expect((yield* readRows).map((r) => r.rung)).toEqual([
          "new",
          "cheap",
          "mid",
          "strong",
          "low",
          "promo",
        ]);
        expect((yield* Effect.flip(addRow(row, { _tag: "Bottom" }))).detail).toMatch(
          /already on the ladder/,
        );
        expect(
          (yield* Effect.flip(addRow({ ...row, rung: "x" }, { _tag: "Above", rung: "nope" })))
            .detail,
        ).toMatch(/no rung nope/);
      }),
    ));

  test("a bad edit changes nothing", () =>
    withStore(
      rig,
      Effect.gen(function* () {
        const rows = yield* readRows;
        expect(
          (yield* Effect.flip(writeRows([{ ...rows[0]!, model: "no/such-model" }]))).detail,
        ).toMatch(/no row in the models table/);
        expect(
          (yield* Effect.flip(writeRows(rows.map((row) => ({ ...row, enabled: false }))))).detail,
        ).toMatch(/every rung is disabled/);
        expect((yield* Effect.flip(writeRows([rows[0]!, rows[0]!]))).detail).toMatch(
          /appears twice/,
        );
        expect((yield* readRows).map((row) => row.rung)).toEqual(["cheap", "strong", "promo"]);
      }),
    ));

  test("a write that fails part way leaves the ladder as it was", () =>
    withStore(
      rig,
      Effect.gen(function* () {
        const rows = yield* readRows;
        // Validation passes; the second insert then violates NOT NULL on the rung.
        const broken = [rows[0]!, { ...rows[1]!, rung: null as unknown as string }];
        yield* Effect.flip(writeRows(broken));
        expect((yield* readRows).map((row) => row.rung)).toEqual(["cheap", "strong", "promo"]);
      }),
    ));
});
