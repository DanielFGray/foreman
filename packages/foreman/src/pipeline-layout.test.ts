import { STANDARD_PIPELINE } from "./pipeline.ts";
import { addRoute, beltOf, insertOn } from "./pipeline-belt.ts";
import { describe, expect, it } from "bun:test";
import { besideOf, type Box, drawingOf, layoutOf, type Point } from "./pipeline-layout.ts";

const branched = () => {
  const withRoute = addRoute(STANDARD_PIPELINE, "retry", "size>=3");
  return insertOn(withRoute, { from: "retry", port: 2 }, "gate").pipeline;
};

const crosses = (a: Point, b: Point, box: Box): boolean => {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  return x1 > box.x && x0 < box.x + box.w && y1 > box.y && y0 < box.y + box.h;
};

describe("layoutOf", () => {
  for (const [name, pipeline] of [
    ["standard", STANDARD_PIPELINE],
    ["branched", branched()],
  ] as const) {
    it(`${name}: no wire runs through a block other than its two ends`, () => {
      const layout = layoutOf(beltOf(pipeline));
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

    it(`${name}: no two wires put their "+" at one place`, () => {
      const anchors = layoutOf(beltOf(pipeline)).wires.map(({ anchor }) => anchor.join(","));
      expect(new Set(anchors).size).toBe(anchors.length);
    });
  }

  // Eleven blocks in ten columns: the branch and worktree chips are as narrow as a land.
  // Each agent exit is a labelled wire, and the author's `already-done` label widens its gap.
  it("the standard pipeline fits in about 1400px", () => {
    const layout = layoutOf(beltOf(STANDARD_PIPELINE));
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
    const drawing = drawingOf(pipeline);
    const layout = layoutOf(beltOf(pipeline));
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
