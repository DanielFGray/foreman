// Where a task stands on the Pipeline drawing. A task whose `stands` is an
// expanded id inside a composite instance is drawn on that instance
// (`docs/composite-blocks.md`). This module uses no herdr-app globals, so
// `bun test` runs it.

/**
 * Each block's tasks. `blocks` are the drawing's cards; a composite card may
 * name the expanded ids it covers. Running first, then by key.
 */
export const byBlock = (placements, blocks = []) => {
  const coverOf = new Map();
  for (const block of blocks) {
    for (const id of block.covers ?? []) coverOf.set(id, block.id);
  }
  const at = new Map();
  for (const placement of placements) {
    const block = coverOf.get(placement.stands) ?? placement.stands;
    at.set(block, [...(at.get(block) ?? []), placement]);
  }
  for (const tasks of at.values()) {
    tasks.sort((a, b) =>
      (a.state === "running") === (b.state === "running")
        ? a.key.localeCompare(b.key)
        : a.state === "running"
          ? -1
          : 1,
    );
  }
  return at;
};
