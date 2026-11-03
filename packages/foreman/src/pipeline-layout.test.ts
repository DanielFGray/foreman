import { STANDARD_PIPELINES } from "./pipeline.ts";
import { addRoute, beltOf, insertOn } from "./pipeline-belt.ts";
import { describe, expect, it } from "bun:test";
import {
  besideOf,
  type Box,
  drawingOf,
  labelWidth,
  layoutOf,
  type Point,
} from "./pipeline-layout.ts";

const branched = () => {
  const withRoute = addRoute(STANDARD_PIPELINES.worktree, "retry", "size>=3");
  return insertOn(withRoute, { from: "retry", port: 2 }, "gate").pipeline;
};

const crosses = (a: Point, b: Point, box: Box): boolean => {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  return x1 > box.x && x0 < box.x + box.w && y1 > box.y && y0 < box.y + box.h;
};

describe("layoutOf", () => {
  for (const [name, pipeline, flow] of [
    ["standard", STANDARD_PIPELINES.worktree, "across"],
    ["branched", branched(), "across"],
    ["standard", STANDARD_PIPELINES.worktree, "down"],
    ["branched", branched(), "down"],
  ] as const) {
    it(`${name}, ${flow}: no wire runs through a block other than its two ends`, () => {
      const layout = layoutOf(beltOf(pipeline), flow);
      for (const { wire, points } of layout.wires) {
        for (const [id, box] of layout.boxes) {
          if (id === wire.from || id === wire.to) continue;
          points
            .slice(1)
            .forEach((point, index) =>
              expect(
                crosses(points[index]!, point, box),
                `${wire.from}→${wire.to} crosses ${id}`,
              ).toBe(false),
            );
        }
      }
    });

    it(`${name}, ${flow}: no two wires put their label or their "+" at one place`, () => {
      const { wires } = layoutOf(beltOf(pipeline), flow);
      for (const at of [
        wires.map(({ anchor }) => anchor.join(",")),
        wires.map(({ plus }) => plus.join(",")),
      ])
        expect(new Set(at).size).toBe(at.length);
    });

    // The boxes the Foreman pane draws: a label is a 14px row centred on
    // its anchor when the flow runs down, and sits above the line across;
    // a "+" is 14px square on its point.
    it(`${name}, ${flow}: no "+" covers a label, another "+" or a block`, () => {
      const layout = layoutOf(beltOf(pipeline), flow);
      const square = ([x, y]: Point, size: number): Box => ({
        x: x - size / 2,
        y: y - size / 2,
        w: size,
        h: size,
      });
      const labels = layout.wires
        .filter(({ wire }) => wire.label !== "")
        .map(({ wire, anchor: [x, y] }) => {
          const w = labelWidth(wire.label);
          return {
            name: `label ${wire.label}`,
            box: {
              x: x - w / 2,
              y: flow === "down" ? y - 7 : y - 14,
              w,
              h: flow === "down" ? 14 : 13,
            },
          };
        });
      const pluses = layout.wires.map(({ wire, plus }) => ({
        name: `+ ${wire.from}/${wire.port}`,
        box: square(plus, 14),
      }));
      const blocks = [...layout.boxes].map(([id, box]) => ({ name: id, box }));
      const overlaps = (a: Box, b: Box) =>
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      for (const plus of pluses)
        for (const other of [...labels, ...pluses, ...blocks])
          if (other !== plus)
            expect(overlaps(plus.box, other.box), `${plus.name} covers ${other.name}`).toBe(false);
    });
  }

  // Eleven blocks in ten columns: the branch and worktree chips are as narrow as a land.
  // Each agent exit is a labelled wire, and the author's `already-done` label widens its gap.
  it("the standard pipeline fits in about 1400px", () => {
    const layout = layoutOf(beltOf(STANDARD_PIPELINES.worktree), "across");
    expect(layout.width).toBeLessThan(1420);
  });
});

describe("besideOf", () => {
  const box: Box = { x: 100, y: 40, w: 100, h: 44 };

  it("floats a panel right of the block when it fits there", () => {
    expect(besideOf(box, 600, 300)).toEqual([212, 40]);
  });

  it("floats it left of a block near the drawing's right edge", () => {
    expect(besideOf({ ...box, x: 500 }, 600, 300)).toEqual([188, 40]);
  });

  it("floats it under the block when neither side has room, inside the drawing", () => {
    expect(besideOf(box, 350, 300)).toEqual([50, 96]);
  });
});

describe("drawingOf", () => {
  it("draws every block once, at its layout box, and survives JSON unchanged", () => {
    const pipeline = branched();
    const drawing = drawingOf(pipeline, "across");
    const layout = layoutOf(beltOf(pipeline), "across");
    expect(drawing.blocks.map((block) => block.id).sort()).toEqual(
      pipeline.nodes.map((node) => node.id).sort(),
    );
    for (const block of drawing.blocks) {
      const { x, y, w, h } = block;
      expect({ x, y, w, h }).toEqual(layout.boxes.get(block.id)!);
    }
    expect(JSON.parse(JSON.stringify(drawing))).toEqual(drawing);
  });
});
