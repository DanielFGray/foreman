// The pane's one drag: model-driven dragging after "Declarative Dragging"
// (Horowitz, Blinn and Heer, https://declarative-dragging.github.io/).
// When a drag starts, the dragged element lists the target states it can
// reach, each with the rectangle the view's own layout gives the element in
// that state and the command that state runs. While it drags, the element
// floats under the pointer, and the closest target within the snap radius is
// the preview. A release runs the preview's command; with no preview, the
// drop does nothing.
//
// The mod has no element drag and drop, so a drag is built from the pointer:
// a press on an element, then a move of more than DRAG_START pixels. A
// shorter move is a click. A release outside the window never arrives, so a
// drag left over is dropped at the next press anywhere in the pane, before
// that press's release could run it.
//
// This module uses no herdr-app globals, so `bun test` runs it. Every point
// and rectangle here is in window coordinates.

export const DRAG_START = 4;
export const SNAP_RADIUS = 40;

export class Drag {
  constructor() {
    // The element being pressed or dragged: its key, where the press was,
    // where the pointer is, the pointer's offset in the element and the
    // element's size, whether it moved far enough to be a drag, and the
    // targets it listed when the drag started.
    this.now = null;
  }

  // A press on an element. `rect` is where the element is drawn now (only
  // its size and the pointer's place in it count); `targets` lists the
  // states it can reach, and runs only when the drag starts.
  press(key, position, rect, targets) {
    this.now = {
      key, from: position, at: position,
      grab: { x: position.x - rect.x, y: position.y - rect.y },
      size: { width: rect.width, height: rect.height },
      dragging: false, listTargets: targets, targets: [],
    };
  }

  // A press anywhere in the pane, which drops a drag whose release never came.
  pressedAnywhere() { if (this.now?.dragging === true) this.now = null; }

  // Follows the pointer. Answers whether the view must draw again.
  moved(position) {
    const now = this.now;
    if (now === null) return false;
    const starts = !now.dragging && Math.hypot(position.x - now.from.x, position.y - now.from.y) > DRAG_START;
    this.now = { ...now, at: position, dragging: now.dragging || starts, targets: starts ? now.listTargets() : now.targets };
    return this.now.dragging;
  }

  // Ends the press. Answers the target to run, or null for a click, a drop
  // outside every snap radius, or no drag.
  released() {
    const target = this.preview();
    this.now = null;
    return target;
  }

  dragging(key) { return this.now?.dragging === true && (key === undefined || this.now.key === key); }

  // The element's rectangle as it floats under the pointer.
  floating() {
    const now = this.now;
    if (now?.dragging !== true) return null;
    return { x: now.at.x - now.grab.x, y: now.at.y - now.grab.y, ...now.size };
  }

  // The target the drop would run: the closest to the floating element's centre.
  preview() {
    const rect = this.floating();
    return rect === null ? null : closest(this.now.targets, centre(rect), SNAP_RADIUS);
  }
}

// The target whose rectangle is closest to `point`, if it is within `radius`.
// A point inside a rectangle is at distance 0. The first listed wins a tie.
export const closest = (targets, point, radius) => {
  let best = null;
  let bestDistance = Infinity;
  for (const target of targets) {
    const d = distance(point, target.rect);
    if (d <= radius && d < bestDistance) { best = target; bestDistance = d; }
  }
  return best;
};

export const distance = (point, rect) => {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
};

export const inside = (point, rect) => rect != null && distance(point, rect) === 0;

const centre = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
