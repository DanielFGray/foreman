import { describe, expect, test } from "bun:test";
import { chargeChange, emptyChange, exitRows } from "./editor-exits.js";

describe("exitRows", () => {
  test("an author's exits may charge itself and be the claim, and a return to the queue says so", () =>
    expect(exitRows({
      kind: "agent", id: "author", role: "author",
      exits: [
        { id: "done", name: "done", to: "review-gate" },
        { id: "already-done", name: "already-done", to: "review-gate", empty: "claim" },
        { id: "exit-0a1b2c3d", name: "stuck", to: "queue", fails: "self" },
      ],
    })).toEqual([
      { name: "done", to: "review-gate", returns: false, fails: "none", charges: ["none", "author", "self"], empty: "unfinished", empties: ["unfinished", "claim"], fixed: false },
      { name: "already-done", to: "review-gate", returns: false, fails: "none", charges: ["none", "author", "self"], empty: "claim", empties: ["unfinished", "claim"], fixed: false },
      { name: "stuck", to: "queue", returns: true, fails: "self", charges: ["none", "author", "self"], empty: "unfinished", empties: ["unfinished", "claim"], fixed: false },
    ]));
  test("a reviewer's exits charge only the author, and none is a claim", () =>
    expect(exitRows({ kind: "agent", id: "review", role: "review", exits: [{ id: "returned", name: "returned", to: "climb", fails: "author" }] })[0])
      .toMatchObject({ fails: "author", charges: ["none", "author"], empties: [] }));
  test("a check's exits keep their names", () =>
    expect(exitRows({ kind: "check", id: "lint", exits: [{ id: "passed", name: "passed", to: "land" }] })[0]).toMatchObject({ fixed: true, charges: ["none", "author"], empties: [] }));
});

describe("chargeChange", () => {
  const node = { kind: "agent", id: "author" };
  test("a charge names the rung", () =>
    expect(chargeChange(node, "stuck", "self")).toEqual({ _tag: "ChargeExit", id: "author", name: "stuck", fails: "self" }));
  test("none clears it", () =>
    expect(chargeChange(node, "stuck", "none")).toEqual({ _tag: "ChargeExit", id: "author", name: "stuck" }));
});

describe("emptyChange", () => {
  const node = { kind: "agent", id: "author" };
  test("claim marks the exit", () =>
    expect(emptyChange(node, "already-done", "claim")).toEqual({ _tag: "SetEmpty", id: "author", name: "already-done", empty: "claim" }));
  test("unfinished clears it", () =>
    expect(emptyChange(node, "already-done", "unfinished")).toEqual({ _tag: "SetEmpty", id: "author", name: "already-done" }));
});
