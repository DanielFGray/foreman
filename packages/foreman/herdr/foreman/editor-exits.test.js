import { describe, expect, test } from "bun:test";
import { chargeChange, exitRows } from "./editor-exits.js";

describe("exitRows", () => {
  test("an author's exits may charge itself, and a return to the queue says so", () =>
    expect(exitRows({
      kind: "agent", id: "author", role: "author",
      exits: [{ name: "done", to: "review-gate" }, { name: "stuck", to: "queue", fails: "self" }],
    })).toEqual([
      { name: "done", to: "review-gate", returns: false, fails: "none", charges: ["none", "author", "self"], fixed: false },
      { name: "stuck", to: "queue", returns: true, fails: "self", charges: ["none", "author", "self"], fixed: false },
    ]));
  test("a reviewer's exits charge only the author", () =>
    expect(exitRows({ kind: "agent", id: "review", role: "review", exits: [{ name: "returned", to: "climb", fails: "author" }] })[0])
      .toMatchObject({ fails: "author", charges: ["none", "author"] }));
  test("a check's exits keep their names", () =>
    expect(exitRows({ kind: "check", id: "lint", exits: [{ name: "passed", to: "land" }] })[0]).toMatchObject({ fixed: true, charges: ["none", "author"] }));
});

describe("chargeChange", () => {
  const node = { kind: "agent", id: "author" };
  test("a charge names the rung", () =>
    expect(chargeChange(node, "stuck", "self")).toEqual({ _tag: "ChargeExit", id: "author", name: "stuck", fails: "self" }));
  test("none clears it", () =>
    expect(chargeChange(node, "stuck", "none")).toEqual({ _tag: "ChargeExit", id: "author", name: "stuck" }));
});
