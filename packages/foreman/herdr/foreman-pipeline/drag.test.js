import { describe, expect, test } from "bun:test";
import { Drag, closest } from "./drag.js";

const stay = { name: "stay", rect: { x: 0, y: 0, width: 100, height: 40 } };
const grant = { name: "grant", rect: { x: 200, y: 0, width: 100, height: 40 } };

describe("closest", () => {
  test("a point inside a target's rectangle picks it", () => {
    expect(closest([stay, grant], { x: 250, y: 20 }, 10)).toBe(grant);
  });

  test("the nearer target wins between two", () => {
    expect(closest([stay, grant], { x: 180, y: 20 }, 100)).toBe(grant);
    expect(closest([stay, grant], { x: 120, y: 20 }, 100)).toBe(stay);
  });

  test("a point outside every snap radius picks nothing", () => {
    expect(closest([stay, grant], { x: 150, y: 20 }, 40)).toBeNull();
    expect(closest([], { x: 0, y: 0 }, 40)).toBeNull();
  });

  test("the first listed target wins a tie", () => {
    expect(closest([stay, grant], { x: 150, y: 20 }, 50)).toBe(stay);
  });
});

describe("Drag", () => {
  const press = (drag) => drag.press("t1", { x: 10, y: 10 }, stay.rect, () => [stay, grant]);

  test("a move shorter than the drag start is a click, which runs nothing", () => {
    const drag = new Drag();
    press(drag);
    expect(drag.moved({ x: 12, y: 11 })).toBe(false);
    expect(drag.released()).toBeNull();
  });

  test("a release runs the target the floating element is closest to", () => {
    const drag = new Drag();
    press(drag);
    drag.moved({ x: 210, y: 10 });
    expect(drag.floating()).toEqual({ x: 200, y: 0, width: 100, height: 40 });
    expect(drag.released()).toBe(grant);
  });

  test("a drag whose release never came is dropped at the next press", () => {
    const drag = new Drag();
    press(drag);
    drag.moved({ x: 210, y: 10 });
    drag.pressedAnywhere();
    expect(drag.released()).toBeNull();
  });
});
