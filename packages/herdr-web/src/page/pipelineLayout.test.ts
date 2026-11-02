import { STANDARD_PIPELINE } from "foreman/pipeline"
import { addRoute, beltOf, insertOn } from "foreman/pipeline-belt"
import { describe, expect, it } from "vitest"
import { type Box, layoutOf, type Point } from "./pipelineLayout.ts"

const branched = () => {
  const withRoute = addRoute(STANDARD_PIPELINE, "retry", "size>=3")
  return insertOn(withRoute, { from: "retry", port: 2 }, "gate").pipeline
}

const crosses = (a: Point, b: Point, box: Box): boolean => {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
  return x1 > box.x && x0 < box.x + box.w && y1 > box.y && y0 < box.y + box.h
}

describe("layoutOf", () => {
  for (const [name, pipeline] of [["standard", STANDARD_PIPELINE], ["branched", branched()]] as const) {
    it(`${name}: no wire runs through a block other than its two ends`, () => {
      const layout = layoutOf(beltOf(pipeline))
      for (const { wire, points } of layout.wires) {
        for (const [id, box] of layout.boxes) {
          if (id === wire.from || id === wire.to) continue
          points.slice(1).forEach((point, index) => expect(crosses(points[index]!, point, box), `${wire.from}→${wire.to} crosses ${id}`).toBe(false))
        }
      }
    })

    it(`${name}: no two wires put their "+" at one place`, () => {
      const anchors = layoutOf(beltOf(pipeline)).wires.map(({ anchor }) => anchor.join(","))
      expect(new Set(anchors).size).toBe(anchors.length)
    })
  }

  // Eleven blocks in ten columns: the branch and worktree chips are as narrow as a land.
  it("the standard pipeline fits in about 1300px", () => {
    const layout = layoutOf(beltOf(STANDARD_PIPELINE))
    expect(layout.width).toBeLessThan(1310)
  })
})
