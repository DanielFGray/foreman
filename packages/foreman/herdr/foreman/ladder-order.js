// The foreman commands a drag in the Models view runs. This module uses no
// herdr-app globals, so `bun test` runs it.

// The `foreman ladder move` that puts a rung at a place in the ladder.
// `rungs` is the ladder in rank order, cheapest first, and `index` is the
// rung's place in it after the move. Index 0 is the bottom; any other place is
// just above the rung that the move leaves below it.
export const moveArgs = (rungs, rung, index) => {
  const rest = rungs.filter((one) => one !== rung);
  return index === 0 ? ["ladder", "move", rung] : ["ladder", "move", rung, "--above", rest[index - 1]];
};

// The `foreman reviewers add` for a card dropped on Reviewers. A worker card
// passes its rung's thinking level; a Models card has none to pass, so the
// reviewer starts at the harness's own default.
export const reviewerArgs = (card) => {
  const level = card.kind === "worker" ? card.rung.thinking : null;
  return ["reviewers", "add", card.model, ...(level ? ["--thinking", level] : [])];
};
