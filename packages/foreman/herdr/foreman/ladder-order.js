// The `foreman ladder move` that puts a rung at a place in the ladder.
// `rungs` is the ladder in rank order, cheapest first, and `index` is the
// rung's place in it after the move. Index 0 is the bottom; any other place is
// just above the rung that the move leaves below it.
//
// This module uses no herdr-app globals, so `bun test` runs it.
export const moveArgs = (rungs, rung, index) => {
  const rest = rungs.filter((one) => one !== rung);
  return index === 0 ? ["ladder", "move", rung] : ["ladder", "move", rung, "--above", rest[index - 1]];
};
