import { describe, expect, test } from "bun:test";
import {
  chargeChange,
  emptyChange,
  entryRows,
  entrySummary,
  exitRows,
  instanceExitRows,
  returnChange,
} from "./editor-exits.js";

describe("exitRows", () => {
  test("an author's exits may charge itself and be the claim, and a return to the queue says so", () =>
    expect(
      exitRows({
        kind: "agent",
        id: "author",
        role: "author",
        exits: [
          { id: "done", name: "done", to: "review-gate" },
          { id: "already-done", name: "already-done", to: "review-gate", empty: "claim" },
          { id: "exit-qzvmktrwpa", name: "stuck", to: "queue", fails: "self" },
        ],
      }),
    ).toEqual([
      {
        name: "done",
        to: "review-gate",
        returns: false,
        fails: "none",
        charges: ["none", "author", "self"],
        empty: "unfinished",
        empties: ["unfinished", "claim"],
        fixed: false,
      },
      {
        name: "already-done",
        to: "review-gate",
        returns: false,
        fails: "none",
        charges: ["none", "author", "self"],
        empty: "claim",
        empties: ["unfinished", "claim"],
        fixed: false,
      },
      {
        name: "stuck",
        to: "queue",
        returns: true,
        fails: "self",
        charges: ["none", "author", "self"],
        empty: "unfinished",
        empties: ["unfinished", "claim"],
        fixed: false,
      },
    ]));
  test("a reviewer's exits charge only the author, and none is a claim", () =>
    expect(
      exitRows({
        kind: "agent",
        id: "review",
        role: "review",
        exits: [{ id: "returned", name: "returned", to: "climb", fails: "author" }],
      })[0],
    ).toMatchObject({ fails: "author", charges: ["none", "author"], empties: [] }));
  test("a check's exits keep their names", () =>
    expect(
      exitRows({
        kind: "check",
        id: "lint",
        exits: [{ id: "passed", name: "passed", to: "land" }],
      })[0],
    ).toMatchObject({ fixed: true, charges: ["none", "author"], empties: [] }));
});

describe("chargeChange", () => {
  const node = { kind: "agent", id: "author" };
  test("a charge names the rung", () =>
    expect(chargeChange(node, "stuck", "self")).toEqual({
      _tag: "ChargeExit",
      id: "author",
      name: "stuck",
      fails: "self",
    }));
  test("none clears it", () =>
    expect(chargeChange(node, "stuck", "none")).toEqual({
      _tag: "ChargeExit",
      id: "author",
      name: "stuck",
    }));
});

describe("emptyChange", () => {
  const node = { kind: "agent", id: "author" };
  test("claim marks the exit", () =>
    expect(emptyChange(node, "already-done", "claim")).toEqual({
      _tag: "SetEmpty",
      id: "author",
      name: "already-done",
      empty: "claim",
    }));
  test("unfinished clears it", () =>
    expect(emptyChange(node, "already-done", "unfinished")).toEqual({
      _tag: "SetEmpty",
      id: "author",
      name: "already-done",
    }));
});

describe("instanceExitRows", () => {
  // The block a definition's instance draws after the palette inserts it: the
  // first exit leads on and every later one returns to the queue, which has no wire.
  const block = {
    id: "review-loop",
    kind: "composite",
    exits: [
      { id: "exit-landable", name: "landable", to: "land-gate" },
      { id: "exit-rework", name: "rework", to: "queue" },
    ],
  };
  test("lists an exit that returns to the queue beside the ones that lead on, by the definition's names", () =>
    expect(instanceExitRows(block)).toEqual([
      { name: "landable", to: "land-gate", returns: false, port: "exit:exit-landable" },
      { name: "rework", to: "queue", returns: true, port: "exit:exit-rework" },
    ]));
  test("an exit at the queue can be led elsewhere through its port, and one that leads on can return", () => {
    const [, queued] = instanceExitRows(block);
    expect({ from: block.id, port: queued.port }).toEqual({
      from: "review-loop",
      port: "exit:exit-rework",
    });
    expect(returnChange(block, "exit:exit-landable")).toEqual({
      _tag: "Rejoin",
      wire: { from: "review-loop", port: "exit:exit-landable" },
      to: "queue",
    });
  });
  test("a block with no exits lists none", () => expect(instanceExitRows(undefined)).toEqual([]));
});

describe("instanceExitRows in an opened definition", () => {
  // A nested instance as `composite show` draws it: one exit leaves the definition by an out, the other returns to the queue.
  const nested = {
    id: "nested",
    kind: "composite",
    exits: [
      { id: "exit-landable", name: "landable", to: "out:exit-done" },
      { id: "exit-rework", name: "rework", to: "queue" },
    ],
  };
  test("lists the exit that leaves by an out and the queued one", () =>
    expect(instanceExitRows(nested).map((row) => [row.name, row.to, row.returns])).toEqual([
      ["landable", "out:exit-done", false],
      ["rework", "queue", true],
    ]));
  test("the queued exit's port is the one a Rejoin to an outer out names", () =>
    expect({
      wire: { from: nested.id, port: instanceExitRows(nested)[1].port },
      to: "out:exit-done",
    }).toEqual({
      wire: { from: "nested", port: "exit:exit-rework" },
      to: "out:exit-done",
    }));
});

describe("entryRows", () => {
  const block = {
    id: "authors",
    summary: "authors",
    entries: [
      { id: "entry-climb", name: "climb", target: "authors" },
      { id: "entry-start", name: "start", target: "authors/entry-start" },
    ],
  };

  test("lists the blocks whose wires enter by each entry, the default taking a wire that names none", () =>
    expect(
      entryRows(block, [
        { from: "retry", to: "authors", label: "" },
        { from: "branch", to: "authors", entry: "entry-start", label: "" },
        { from: "review", to: "authors", entry: "entry-climb", label: "returned" },
        { from: "review", to: "land-gate", label: "approved" },
      ]),
    ).toEqual([
      { name: "climb", target: "authors", from: ["retry", "review"] },
      { name: "start", target: "authors/entry-start", from: ["branch"] },
    ]));

  test("a block with one entry or none has nothing to choose, and the summary names the entries only when several", () => {
    expect(entryRows({ id: "x", entries: [] }, [])).toEqual([]);
    expect(entrySummary({ summary: "authors" , entries: block.entries.slice(0, 1) })).toBe("authors");
    expect(entrySummary(block)).toBe("authors · in: climb, start");
  });
});
