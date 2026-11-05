import { expect, test } from "bun:test";
import { ROW, columnsOf, dropsOf, nextThinking, rowsOf, reviewerArgs, rungNameFor, thinkingArgs } from "./models-board.js";

const rung = (name, level, enabled, extra = {}) => ({ rung: name, level, model: `m/${name}`, thinking: "low", enabled, ...extra });

// Levels 1 and 4 hold enabled rungs; level 2 holds a disabled one, level 3
// nothing. `free` is a model nothing names; `old` is retired.
const ladder = {
  rungs: [rung("a", 1, true), rung("b", 1, true), rung("off", 2, false), rung("c", 4, true)],
  models: [
    { model: "m/a", harness: "pi", retired: false },
    { model: "m/off", harness: "pi", retired: false },
    { model: "m/rev", harness: "pi", retired: false },
    { model: "free", harness: "pi", retired: false },
    { model: "old", harness: "pi", retired: true },
  ],
  reviewers: [{ name: "rev", model: "m/rev", thinking: "high" }],
};
const columns = columnsOf(ladder);
const card = (key) => columns.flatMap((column) => column.cards).find((one) => one.key === key);
const drop = (key, zone) => dropsOf(card(key), columns, ladder).find((one) => JSON.stringify(one.zone) === JSON.stringify(zone))?.commands;

test("a column per level with an enabled rung, then Reviewers, then Available", () => {
  expect(columns.map((column) => [column.label, column.cards.map((one) => one.name)])).toEqual([
    ["Level 1", ["a", "b"]],
    ["Level 4", ["c"]],
    ["Reviewers", ["rev"]],
    ["Available", ["off", "free"]],
  ]);
});

test("each column is a row, its cards wrapping to the view's width, and a folded row shows no cards", () => {
  const { rows, cards, gaps, height } = rowsOf(columns, 560, new Set(["available"]));
  expect(rows.map((row) => [row.column.key, row.rect.y, row.rect.height])).toEqual([
    ["level:1", 12, 40], ["level:4", 66, 40], ["reviewers", 134, 40], ["available", 188, 40],
  ]);
  expect([cards.get("rung:a"), cards.get("rung:b")]).toEqual([
    { x: 140, y: 12, width: 200, height: ROW.CARD_H }, { x: 348, y: 12, width: 200, height: ROW.CARD_H },
  ]);
  expect(cards.has("rung:off")).toBe(false);
  expect(gaps.map((gap) => gap.y)).toEqual([-2, 52, 106]);
  expect(height).toBe(240);
});

test("a view too narrow for two cards puts one card on each line", () => {
  const { rows, cards } = rowsOf(columns, 300, new Set());
  expect(rows[0].rect.height).toBe(2 * ROW.CARD_H + ROW.GAP);
  expect(cards.get("rung:b")).toEqual({ x: 140, y: 12 + ROW.CARD_H + ROW.GAP, width: 200, height: ROW.CARD_H });
});

test("an enabled rung joins another level, or takes a level of its own in a gap", () => {
  expect(drop("rung:a", { kind: "column", key: "level:4" })).toEqual([["ladder", "level", "a", "4"]]);
  expect(drop("rung:a", { kind: "gap", at: 0 })).toEqual([["ladder", "move", "a", "--below", "b"]]);
  expect(drop("rung:a", { kind: "gap", at: 1 })).toEqual([["ladder", "move", "a", "--below", "c"]]);
  expect(drop("rung:a", { kind: "gap", at: 2 })).toEqual([["ladder", "move", "a", "--above", "c"]]);
});

test("a rung alone in its level has no drop on its own column or the gaps beside it", () => {
  const zones = dropsOf(card("rung:c"), columns, ladder).map((one) => one.zone);
  expect(zones).toContainEqual({ kind: "gap", at: 0 });
  expect(zones).not.toContainEqual({ kind: "gap", at: 1 });
  expect(zones).not.toContainEqual({ kind: "gap", at: 2 });
  expect(zones).not.toContainEqual({ kind: "column", key: "level:4" });
  expect(drop("rung:c", { kind: "gap", at: 0 })).toEqual([["ladder", "move", "c", "--below", "a"]]);
});

test("a rung that shares its level can leave it on either side, naming a peer", () => {
  expect(drop("rung:b", { kind: "gap", at: 0 })).toEqual([["ladder", "move", "b", "--below", "a"]]);
  expect(drop("rung:b", { kind: "gap", at: 1 })).toEqual([["ladder", "move", "b", "--below", "c"]]);
  expect(dropsOf(card("rung:b"), columns, ladder).map((one) => one.zone)).not.toContainEqual({ kind: "column", key: "level:1" });
});

test("a disabled rung is moved first and enabled last", () => {
  expect(drop("rung:off", { kind: "column", key: "level:1" })).toEqual([["ladder", "level", "off", "1"], ["ladder", "enable", "off"]]);
  expect(drop("rung:off", { kind: "gap", at: 1 })).toEqual([["ladder", "move", "off", "--below", "c"], ["ladder", "enable", "off"]]);
  expect(drop("rung:off", { kind: "column", key: "available" })).toBeUndefined();
});

test("an enabled rung dropped on Available is disabled", () => {
  expect(drop("rung:a", { kind: "column", key: "available" })).toEqual([["ladder", "disable", "a"]]);
});

test("a model becomes a rung named after it, with no thinking level", () => {
  expect(drop("model:free", { kind: "column", key: "level:4" })).toEqual([["ladder", "add", "free", "free", "--level", "4"]]);
  expect(drop("model:free", { kind: "gap", at: 2 })).toEqual([["ladder", "add", "free", "free", "--above", "c"]]);
});

test("a taken rung name gets the first free number after it", () => {
  expect(rungNameFor("x", [{ rung: "x" }, { rung: "x-2" }])).toBe("x-3");
  expect(rungNameFor("x", [{ rung: "y" }])).toBe("x");
});

test("with no enabled rung, the one gap is the bottom", () => {
  const empty = { rungs: [rung("off", 2, false)], models: [{ model: "free", harness: "pi", retired: false }], reviewers: [] };
  const bare = columnsOf(empty);
  const model = bare.find((column) => column.key === "available").cards.find((one) => one.kind === "model");
  expect(dropsOf(model, bare, empty).filter((one) => one.zone.kind === "gap")).toEqual([
    { zone: { kind: "gap", at: 0 }, commands: [["ladder", "add", "free", "free"]] },
  ]);
});

test("Reviewers takes a rung or a model whose model reviews nothing, and gives a reviewer back", () => {
  expect(drop("rung:a", { kind: "column", key: "reviewers" })).toEqual([["reviewers", "add", "m/a", "--thinking", "low"]]);
  expect(drop("model:free", { kind: "column", key: "reviewers" })).toEqual([["reviewers", "add", "free"]]);
  expect(drop("reviewer:rev", { kind: "column", key: "available" })).toEqual([["reviewers", "remove", "rev"]]);
  expect(dropsOf(card("reviewer:rev"), columns, ladder).map((one) => one.zone)).toEqual([{ kind: "column", key: "available" }]);
});

test("a rung with no level passes no thinking flag to a new reviewer", () => {
  expect(reviewerArgs({ kind: "rung", model: "auto", thinking: null })).toEqual(["reviewers", "add", "auto"]);
});

test("a click steps the thinking level none, low, medium, high, none", () => {
  expect([null, "low", "medium", "high", "max"].map(nextThinking)).toEqual(["low", "medium", "high", null, null]);
  expect(thinkingArgs(card("rung:a"))).toEqual(["ladder", "thinking", "a", "medium"]);
  expect(thinkingArgs(card("reviewer:rev"))).toEqual(["reviewers", "thinking", "rev", "none"]);
  expect(thinkingArgs(card("model:free"))).toBeNull();
});
