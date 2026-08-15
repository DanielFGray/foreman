/**
 * The models foreman may use, ordered cheapest first.
 *
 * Order is the rating. There are no price or power numbers to drift out of step
 * with the list, and no map from author to reviewer: the reviewer is the next
 * rung up, and a task that fails climbs one step. Both fall out of the order.
 *
 * Above the last configured rung is the operator. They are not an entry in the
 * array, because a rung with no harness and no model is a different kind of
 * thing, and an explicit entry invites putting a person in the middle — where
 * every task below them would stall behind a human who is asleep.
 */
export type Ladder = readonly [Rung, ...ReadonlyArray<Rung>];

export interface Rung {
  /** How this rung is named in the config, in labels, and on the dashboard. */
  readonly name: string;

  /** A herdr agent kind: the program that runs. */
  readonly harness: string;

  /**
   * Passed to the harness as `--model`, which opencode and claude both accept.
   * Absent means the harness picks, which is what a rung named after a harness
   * rather than a model wants.
   */
  readonly model: string | undefined;
}

/**
 * The rung that writes the code next, or undefined when that is the operator.
 *
 * A task with no rung label has not failed anywhere, so it starts at the
 * bottom. A label naming a rung that the config no longer has is the operator's
 * too: the claim "this task needs at least this model" cannot be read once the
 * model is gone, and guessing at it would silently downgrade work that had
 * already earned something better.
 */
export const authorFor = (ladder: Ladder, rung: string | undefined): Rung | undefined =>
  rung === undefined ? ladder[0] : ladder.find((candidate) => candidate.name === rung);

/**
 * The rung one step up, which is `HUMAN` at the top and stays there.
 *
 * One step at a time, never a jump: a task that a cheap model could not finish
 * has shown that cheap is not enough, and nothing more.
 */
export const above = (ladder: Ladder, rung: string | undefined): string => {
  const current = rung === undefined ? 0 : ladder.findIndex((candidate) => candidate.name === rung);
  if (current < 0) return HUMAN;
  return ladder[current + 1]?.name ?? HUMAN;
};

/**
 * The rung one step down, and `undefined` where there is nothing to write.
 *
 * One step at a time, never a jump: lowering a task is the operator saying a
 * climb was not earned, and a rung is only ever as good as the evidence that
 * wrote it. A task on the operator's own rung comes down to the top rung — a
 * person was never a model, and correcting the climb puts the strongest model
 * next rather than dropping to the bottom. Below the bottom rung the ladder
 * reads no label as the default, so there is nothing to write; a rung the
 * config no longer has cannot be positioned, so like `above` it is read as
 * sitting above the top rung.
 */
export const below = (ladder: Ladder, rung: string | undefined): string | undefined => {
  const current = rung === undefined ? 0 : ladder.findIndex((candidate) => candidate.name === rung);
  if (current < 0) return ladder[ladder.length - 1]?.name;
  if (current <= 0) return undefined;
  return ladder[current - 1]?.name;
};

/**
 * Who reads the work of a given rung.
 *
 * The next rung up, so cheap work gets expensive eyes — which is where most of
 * review's value is. The top rung reviews itself: fresh eyes on the same model
 * still catch things, because the reviewer arrives with no sunk cost in the
 * implementation. Work with no author recorded gets the top rung, since nothing
 * says how much judgement it needs.
 *
 * Model rungs only. A person intervening in a review takes the pane over; they
 * are never dispatched into one.
 */
export const reviewerFor = (ladder: Ladder, author: string | undefined): Rung => {
  const top = ladder[ladder.length - 1] ?? ladder[0];
  const current = ladder.findIndex((candidate) => candidate.name === author);
  if (current < 0) return top;
  return ladder[current + 1] ?? top;
};

/** Reading a hundred files of abandoned work is what cheap models are worst at. */
export const topOf = (ladder: Ladder): Rung => ladder[ladder.length - 1] ?? ladder[0];

/**
 * The rung name reserved for the operator, so it can be written on a climb from
 * the top. Rejected as a rung name in the config: a model called `human` would
 * make a waiting task indistinguishable from a dispatchable one.
 */
export const HUMAN = "human";

/** Whether a task at this rung is waiting for a person rather than an agent. */
export const isYours = (ladder: Ladder, rung: string | undefined): boolean =>
  authorFor(ladder, rung) === undefined;
