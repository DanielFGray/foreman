// What the Models view shows and what each drop on it runs, from one
// `foreman ladder --json`. This module uses no herdr-app globals, so `bun test`
// runs it; `models.js` draws it and runs the commands.
//
// The columns, in the order the view stacks them as rows:
// - one per ladder level that holds an enabled rung, cheapest first, with its
//   enabled rungs in rank order. A level is labelled by its place, 1 up: the
//   number the ladder stores only orders the levels, and has gaps. A level of
//   disabled rungs only has no column: most stored levels hold one retired
//   rung each.
// - Reviewers.
// - Available: every disabled rung and every model that no rung and no
//   reviewer names, to make a rung or a reviewer from, in one group per
//   provider (the account the model bills), providers by name. Available and
//   each of its groups is closed until the operator opens it, so its cards
//   show only on request.
//
// A drop names a zone, a column or the gap before level `at` (the gap at the
// count of levels is the one after the last), and the foreman
// commands it runs, in order. A drop that enables a rung moves it first and
// enables it last, so a refusal part way leaves it disabled.

// The thinking levels a click on a card steps through; null passes no flag, so
// the harness's own default applies.
export const THINKING = [null, "low", "medium", "high"];

// The level after `level`. A level outside the cycle, which only the command
// line can set, steps to none.
export const nextThinking = (level) => THINKING[(THINKING.indexOf(level ?? null) + 1) % THINKING.length];

export const columnsOf = ({ rungs, models, reviewers }) => {
  const levels = [...new Set(rungs.filter((rung) => rung.enabled).map((rung) => rung.level))].sort((a, b) => a - b);
  const seated = new Set([...rungs, ...reviewers].map((seat) => seat.model));
  return [
    ...levels.map((level, index) => ({
      key: `level:${level}`, kind: "level", level, label: `Level ${index + 1}`,
      cards: rungs.filter((rung) => rung.enabled && rung.level === level).map(rungCard),
    })),
    {
      key: "reviewers", kind: "reviewers", label: "Reviewers",
      cards: reviewers.map((one) => ({
        key: `reviewer:${one.name}`, kind: "reviewer", name: one.name, model: one.model, thinking: one.thinking ?? null, reviewer: one,
      })),
    },
    availableOf(rungs, models, seated),
  ];
};

// The Available column, its cards grouped by provider.
const availableOf = (rungs, models, seated) => {
  const providers = new Map(models.map((one) => [one.model, one.provider]));
  const cards = [
    ...rungs.filter((rung) => !rung.enabled).map(rungCard),
    ...models.filter((one) => !one.retired && !seated.has(one.model)).map((one) => ({
      key: `model:${one.model}`, kind: "model", name: one.model, model: one.model, thinking: null, harness: one.harness,
    })),
  ];
  const groups = [...new Set(cards.map((card) => providers.get(card.model)))].sort().map((provider) => ({
    key: `available:${provider}`, label: provider, cards: cards.filter((card) => providers.get(card.model) === provider),
  }));
  return { key: "available", kind: "available", label: "Available", groups, cards: groups.flatMap((group) => group.cards) };
};

export const ROW = { PAD: 12, LABEL_W: 128, CARD_MIN: 200, CARD_H: 40, GAP: 8, ROW_GAP: 14, SECTION_GAP: 28, HEAD_H: 24 };

// Where the view draws each column as a row in a view `width` wide: its label
// at the left and its cards wrapping to the right, rows stacked top down, and
// a wider space between the last level and the rest. A column with groups
// (Available) shows its label alone until `open` holds its key; open, it
// shows each group's head, and a group's cards when `open` holds the group's
// key. Each level gap is a strip across the space between two level rows, or
// above the first or below the last. Rectangles are in content coordinates;
// the view subtracts its scroll. `height` is how tall the content stands.
export const rowsOf = (columns, width, open) => {
  const { PAD, LABEL_W, CARD_MIN, CARD_H, GAP, ROW_GAP, SECTION_GAP, HEAD_H } = ROW;
  const left = PAD + LABEL_W;
  const room = Math.max(CARD_MIN, width - left - PAD);
  const perLine = Math.max(1, Math.floor((room + GAP) / (CARD_MIN + GAP)));
  const cardW = (room - (perLine - 1) * GAP) / perLine;
  const rows = [];
  const heads = [];
  const cards = new Map();
  // Lays `list` out from `top`, and answers where the next line starts.
  const wrap = (list, top) => {
    list.forEach((card, at) => cards.set(card.key, {
      x: left + (at % perLine) * (cardW + GAP), y: top + Math.floor(at / perLine) * (CARD_H + GAP), width: cardW, height: CARD_H,
    }));
    return top + Math.ceil(list.length / perLine) * (CARD_H + GAP);
  };
  let y = PAD;
  columns.forEach((column, index) => {
    if (column.kind !== "level" && columns[index - 1]?.kind === "level") y += SECTION_GAP - ROW_GAP;
    let bottom = y;
    if (column.groups === undefined) bottom = wrap(column.cards, y);
    else if (open.has(column.key)) {
      for (const group of column.groups) {
        heads.push({ group, open: open.has(group.key), rect: { x: left, y: bottom, width: room, height: HEAD_H } });
        bottom = open.has(group.key) ? wrap(group.cards, bottom + HEAD_H + GAP) : bottom + HEAD_H + GAP;
      }
    }
    const height = Math.max(CARD_H, bottom - GAP - y);
    rows.push({ column, rect: { x: PAD, y, width: left + room - PAD, height } });
    y += height + ROW_GAP;
  });
  const levels = rows.filter((row) => row.column.kind === "level");
  const strip = (middle) => ({ x: PAD, y: middle - ROW_GAP / 2, width: left + room - PAD, height: ROW_GAP });
  const gaps = levels.length === 0
    ? [strip(PAD / 2)]
    : [...levels.map((row) => strip(row.rect.y - ROW_GAP / 2)), strip(levels.at(-1).rect.y + levels.at(-1).rect.height + ROW_GAP / 2)];
  return { rows, heads, cards, gaps, height: y - ROW_GAP + PAD };
};

// Every drop `card` can make on `columns`, each with the commands it runs.
// Dropping a card where it already stands runs nothing, so it is not listed.
export const dropsOf = (card, columns, ladder) => {
  const levels = columns.filter((column) => column.kind === "level");
  const home = columns.find((column) => column.cards.some((one) => one.key === card.key));
  const drops = [];
  if (card.kind === "rung" || card.kind === "model") {
    for (let at = 0; at <= levels.length; at++) {
      const place = gapPlace(levels, at, card);
      if (place !== null) drops.push({ zone: { kind: "gap", at }, commands: placed(card, { own: place }, ladder) });
    }
    for (const column of levels) {
      if (column !== home) drops.push({ zone: { kind: "column", key: column.key }, commands: placed(card, { join: column.level }, ladder) });
    }
  }
  if (card.kind === "rung" && card.rung.enabled) drops.push({ zone: { kind: "column", key: "available" }, commands: [["ladder", "disable", card.name]] });
  if (card.kind === "reviewer") drops.push({ zone: { kind: "column", key: "available" }, commands: [["reviewers", "remove", card.name]] });
  if (card.kind !== "reviewer" && !ladder.reviewers.some((one) => one.model === card.model)) {
    drops.push({ zone: { kind: "column", key: "reviewers" }, commands: [reviewerArgs(card)] });
  }
  return drops;
};

// The command a click on a card's thinking level runs: the next level in the
// cycle. A model card has no level of its own.
export const thinkingArgs = (card) => {
  const next = nextThinking(card.thinking) ?? "none";
  if (card.kind === "rung") return ["ladder", "thinking", card.name, next];
  if (card.kind === "reviewer") return ["reviewers", "thinking", card.name, next];
  return null;
};

// A new rung's name: its model's id, unless a rung has that name already, and
// then the id with the first free `-2`, `-3`, ... after it.
export const rungNameFor = (model, rungs) => {
  const taken = new Set(rungs.map((rung) => rung.rung));
  let name = model;
  for (let n = 2; taken.has(name); n++) name = `${model}-${n}`;
  return name;
};

// The `foreman reviewers add` for a card dropped on Reviewers. A rung card
// passes its rung's thinking level; a model card has none to pass, so the
// reviewer starts at the harness's own default.
export const reviewerArgs = (card) => {
  const level = card.kind === "rung" ? card.thinking : null;
  return ["reviewers", "add", card.model, ...(level ? ["--thinking", level] : [])];
};

const rungCard = (rung) => ({ key: `rung:${rung.rung}`, kind: "rung", name: rung.rung, model: rung.model, thinking: rung.thinking ?? null, rung });

// The flags that put a rung in a level of its own in the gap before level
// column `at`: just below that column's level, or just above the last level
// for the gap after it. With no level column, the bottom. The neighbour named
// is never the dragged rung, and a gap beside a column that holds only the
// dragged rung is no move at all, so it has no place.
//
// Just below the right-hand level, rather than just above the left-hand one,
// puts the rung above every disabled rung between the two, so a task charged
// on one of those still reaches it.
const gapPlace = (levels, at, card) => {
  if (levels.length === 0) return [];
  const others = (column) => column.cards.filter((one) => one.key !== card.key);
  const alone = (column) => column !== undefined && others(column).length === 0;
  if (alone(levels[at]) || alone(levels[at - 1])) return null;
  return at < levels.length ? ["--below", others(levels[at])[0].name] : ["--above", others(levels[at - 1]).at(-1).name];
};

// The commands that put `card` in a level of its own (`own`: the place flags
// `gapPlace` gives) or into an existing level (`join`): a rung moves there, and
// a disabled one is enabled after; a model becomes a rung there, named by
// `rungNameFor`, with no thinking level.
const placed = (card, { own, join }, ladder) => {
  const flags = own ?? ["--level", String(join)];
  if (card.kind === "model") return [["ladder", "add", rungNameFor(card.model, ladder.rungs), card.model, ...flags]];
  const move = own !== undefined ? ["ladder", "move", card.name, ...own] : ["ladder", "level", card.name, String(join)];
  return card.rung.enabled ? [move] : [move, ["ladder", "enable", card.name]];
};
