import { Array as Arr, Order } from "effect";

/**
 * The models foreman may use, as an ordered list of levels, cheapest first.
 *
 * A level holds any number of rungs, and the rungs of one level are peers that
 * share the author work: an author is the least recently started affordable
 * rung of the lowest level the task may take. The array holds every rung,
 * sorted by (level, rank); rank is the order inside a level and breaks ties.
 * There are no price or power numbers to drift out of step with the list. A
 * task that fails a rung records that failure, and one failure on any rung of
 * a level sends the task up a level. A rung's `author` switch takes it out of
 * the author pick without changing the order.
 *
 * The ladder decides only who writes. A review block reads from the
 * reviewers, a list of its own (`src/reviewers.ts`).
 *
 * A task never names the model that runs next. It records which models have
 * already failed it, and the rung is chosen here from what is available now —
 * so retiring a model, or spending its allowance, moves work onto the next one
 * that can take it instead of stranding it. Above the last level is the
 * operator, who is not an entry in the array: a rung with no harness and no
 * model is a different kind of thing, and an explicit entry invites putting a
 * person in the middle, where every task below them would stall behind
 * somebody asleep.
 */
export type Ladder = readonly [Rung, ...ReadonlyArray<Rung>];

/**
 * A model foreman launches as an agent: a ladder rung, which writes, or a
 * reviewer (`src/reviewers.ts`), which reads. The launch, the run record and
 * the account read only these fields.
 */
export interface Seat {
  /** How this entry is named in labels, in the runs it records, and on the dashboard. */
  readonly name: string;

  /** The harness kind: the program that runs (see `harnessLaunch`). */
  readonly harness: string;

  /**
   * The model this entry runs. Each harness is told in the way it accepts one —
   * `--model` for claude and codex, a private-server config for opencode — and
   * that mapping lives in `src/harness.ts`, not here. Absent means the
   * harness picks, which is what a rung named after a harness rather than a
   * model wants.
   */
  readonly model: string | undefined;

  /**
   * The account whose allowance this entry spends, where the model does not say.
   *
   * Quota belongs to an account rather than to a rung, so this is what several
   * entries share when they draw on one plan. Usually derivable — see
   * `providerOf` — and stated only where it is not.
   */
  readonly provider: string | undefined;

  /**
   * Whether the account's allowance says nothing about this entry's room.
   * False means the allowance describes it.
   *
   * A model served on promotional access — a launch give-away, a partner's
   * sponsored endpoint — draws on a pool that is not the one the account's
   * percentage measures. Walling such a rung on that percentage is the one false
   * wall there is: it passes over work the account can still pay for, and the
   * task then waits for a reset that was never going to matter.
   *
   * Stated rather than derived, because only the operator knows which models a
   * provider is currently sponsoring. Getting it wrong in this direction is the
   * safe one: a metered rung left out is dispatched on an empty account and
   * meets the wall itself, which is where the fleet stood before any of this was
   * read at all.
   */
  readonly unmetered: boolean;

  /**
   * How hard the model thinks, such as `low` or `medium`. Each rung and each
   * reviewer states its own, so two entries of one model may think
   * differently. The adapter turns it into the flag the harness takes. Absent,
   * or on a harness with no such flag, no flag is passed and the harness's own
   * default applies.
   */
  readonly thinking?: string | undefined;
}

/** One rung of the ladder: a seat that writes, at a level. */
export interface Rung extends Seat {
  /**
   * The level this rung stands at. Levels climb in number, and the rungs of one
   * level are peers. An integer the operator sets (`foreman ladder level`).
   */
  readonly level: number;

  /**
   * Whether foreman may dispatch this rung.
   *
   * A retired model stays in the ladder, disabled, so it keeps its level: the
   * failures it recorded still say "cheaper than the level above was not
   * enough", which is the whole of what a rung means. Deleting the entry
   * instead says the model is no longer part of the rating at all, and the
   * failures naming it stop positioning anything.
   */
  readonly enabled: boolean;

  /**
   * Whether this rung may author.
   *
   * Independent of `enabled`: a model that must never write keeps `author:
   * false` without being retired. The `ladder` model rule and a pin to this
   * rung both require it on.
   */
  readonly author: boolean;
}

/** Whether foreman may dispatch a rung: everything but a retirement. */
export const isEnabled = (rung: Rung): boolean => rung.enabled;

/** Whether this rung may take an author block (`ladder` or a pin). */
export const mayAuthor = (rung: Rung): boolean => rung.author;

/** Whether this entry's room is described by the allowance of its account. */
export const isMetered = (seat: Seat): boolean => !seat.unmetered;

/**
 * Which rung authors next, and why there is none when there is none.
 *
 * `Waiting` and `Yours` are different answers and must not be collapsed. A
 * rung nobody can pay for is a fact about a wallet that an allowance reset
 * clears by itself, so the task waits in the queue; a ladder whose every rung
 * has already failed the task is a fact about the work, and only a person can
 * answer it.
 */
export type Choice =
  | { readonly _tag: "Dispatch"; readonly rung: Rung }
  | { readonly _tag: "Waiting"; readonly walled: ReadonlyArray<string> }
  | { readonly _tag: "Yours" };

/**
 * The latest run start of each rung, by rung name: the turn order inside a
 * level. A rung with no entry has never started, and so takes the first turn.
 */
export type LastStarts = ReadonlyMap<string, Date>;

/**
 * The rung that writes the code next: from the lowest level above every level
 * that has failed this task, the affordable rung that started least recently.
 *
 * `failures` is what the task durably records. A failure naming a rung the
 * config no longer has cannot be positioned and so constrains nothing — the
 * config having dropped that model is the operator saying it is not part of
 * the rating any more.
 *
 * `walled` names the rungs whose account is spent. They are unavailable rather
 * than failed: nothing about an allowance is evidence about a model, so the
 * search steps over them without the task recording anything, and the ordinary
 * rung is chosen again once the account has room.
 *
 * `lastStarts` orders the rungs of one level, so its peers take turns. Empty,
 * the order is the rank, which keeps a one-shot reader deterministic.
 *
 * `drawn` names the accounts this same tick has already dispatched an author
 * on, and is a preference rather than a wall. Every free slot in one tick reads
 * the same allowances, so without it a tick's whole burst draws on the cheapest
 * funded account until that account dies mid-round — which is a fact about the
 * wallet, answered by the next reading, not by which model happened to be first
 * in the list.
 *
 * It can never turn a `Dispatch` into a `Waiting`: when every affordable rung
 * draws on an account already spent this tick, the first affordable rung in
 * turn order is taken anyway. An account that has room is never called spent,
 * and a rung whose account cannot be named is never treated as drawn on.
 */
export const authorFor = (
  ladder: Ladder,
  failures: ReadonlyArray<string>,
  walled: ReadonlySet<string> = new Set(),
  drawn: ReadonlySet<string> = new Set(),
  lastStarts: LastStarts = new Map(),
): Choice => {
  const floor = floorFor(ladder, failures);
  const candidates = ladder.filter(
    (candidate) => candidate.level >= floor && isEnabled(candidate) && mayAuthor(candidate),
  );
  const affordable = Arr.sort(
    candidates.filter((candidate) => !walled.has(candidate.name)),
    turnOrder(lastStarts),
  );
  const rung =
    affordable.find((candidate) => !drawn.has(providerOf(candidate) ?? "")) ?? affordable[0];
  if (rung !== undefined) return { _tag: "Dispatch", rung };
  return candidates.length === 0
    ? { _tag: "Yours" }
    : { _tag: "Waiting", walled: candidates.map((candidate) => candidate.name) };
};

/**
 * Level first, then the least recently started, then rank. The sort is stable
 * and the ladder is in rank order, so rank needs no key of its own.
 */
const turnOrder = (lastStarts: LastStarts): Order.Order<Rung> =>
  Order.combine(
    Order.mapInput(Order.Number, (rung: Rung) => rung.level),
    leastRecentFirst(lastStarts),
  );

/** The seat whose last run started longest ago first; one that never started before all. */
export const leastRecentFirst = (lastStarts: LastStarts): Order.Order<Seat> =>
  Order.mapInput(
    Order.Number,
    (seat: Seat) => lastStarts.get(seat.name)?.getTime() ?? Number.NEGATIVE_INFINITY,
  );

/**
 * The lowest level an author may take: one above the highest level that has
 * failed this task, else the bottom level.
 *
 * Levels, not names, so a failure on a rung since retired still holds the work
 * above its level as long as that rung keeps its place in the config. One
 * failure on any rung of a level puts every rung of that level below the floor.
 */
export const floorFor = (ladder: Ladder, failures: ReadonlyArray<string>): number =>
  failures.reduce((floor, failure) => {
    const level = levelOf(ladder, failure);
    return level === undefined ? floor : Math.max(floor, level + 1);
  }, ladder[0].level);

/** Where a rung sits in the order of the array, or nothing for one the config has dropped. */
export const rankOf = (ladder: Ladder, name: string): number | undefined => {
  const rank = ladder.findIndex((rung) => rung.name === name);
  return rank < 0 ? undefined : rank;
};

/** The level a rung stands at, or nothing for one the config has dropped. */
export const levelOf = (ladder: Ladder, name: string): number | undefined =>
  ladder.find((rung) => rung.name === name)?.level;

/**
 * The names of the rungs at the named rung's level, the named rung among them.
 * Only the named rung for one the config has dropped: it has no level left to
 * share.
 */
export const levelPeers = (ladder: Ladder, name: string): ReadonlyArray<string> => {
  const level = levelOf(ladder, name);
  return level === undefined
    ? [name]
    : ladder.filter((rung) => rung.level === level).map((rung) => rung.name);
};

/**
 * The highest-ranked rung a task records as having failed it. It stands at the
 * highest failed level, the level the operator's correction takes back.
 *
 * Unrecognised names are skipped rather than guessed at: a failure that cannot
 * be positioned is not holding the task anywhere, so removing it would correct
 * nothing.
 */
export const highestFailure = (
  ladder: Ladder,
  failures: ReadonlyArray<string>,
): string | undefined =>
  failures.reduce<{ name: string; rank: number } | undefined>((highest, failure) => {
    const rank = rankOf(ladder, failure);
    if (rank === undefined) return highest;
    return highest === undefined || rank > highest.rank ? { name: failure, rank } : highest;
  }, undefined)?.name;

/**
 * Whether a level with this many stopped attempts is spent, so the task
 * records the failure and moves up a level.
 *
 * An agent that stops without finishing says nothing about its model — a
 * crash, a timeout and a usage wall all end the same way — so the first
 * `attemptsPerLevel - 1` stops retry the level, each on the rung whose turn it
 * is, and the one that reaches `attemptsPerLevel` fails the rung that ran it.
 * Judgements never count: a reviewer sending work back, or a branch that broke
 * verification, fails the rung on the strength of the verdict alone.
 */
export const levelSpent = (attempts: number, attemptsPerLevel: number): boolean =>
  attempts >= attemptsPerLevel;

/** The rungs foreman may dispatch, in rating order — what a chooser offers. */
export const dispatchable = (ladder: Ladder): ReadonlyArray<Rung> => ladder.filter(isEnabled);

/**
 * The account a seat spends, which is what has an allowance.
 *
 * opencode names a model `<provider>/<model>`, so for every seat that names one
 * the account is already written down and stating it again would let the two
 * drift. The claude harness is the one default that is not in doubt — the
 * `claude` binary is always signed into the claude.ai account, however it
 * picks its model — so a seat on it spends `claude` even when it names no
 * model. Any other seat that names no model, or names one without a provider
 * on the front, has to be told; until it is, foreman cannot know whether that
 * seat has room left.
 */
export const providerOf = (seat: Seat): string | undefined => {
  if (seat.provider !== undefined) return seat.provider;
  if (seat.model !== undefined) {
    const [provider, ...rest] = seat.model.split("/");
    if (rest.length > 0 && provider !== undefined && provider.length > 0) return provider;
  }
  return seat.harness === "claude" ? "claude" : undefined;
};

/**
 * Every distinct account the ladder and the reviewers draw on, which is what
 * to ask about.
 *
 * Dispatchable rungs only: a retired rung keeps its place so old failures still
 * position, but nothing will ever spend its account again, and an allowance
 * nothing can spend is not news.
 *
 * Metered seats only, for the same reason and the same way: an account whose
 * every seat is fed by a promotional pool is asked nothing, because no reading
 * of it could stop a dispatch. It is probed once per tick, so this saves a
 * request per tick rather than tidying a list.
 */
export const providersOf = (
  ladder: Ladder,
  reviewers: ReadonlyArray<Seat> = [],
): ReadonlyArray<string> => [
  ...new Set(
    [...dispatchable(ladder), ...reviewers].filter(isMetered).flatMap((seat) => {
      const provider = providerOf(seat);
      return provider === undefined ? [] : [provider];
    }),
  ),
];

/**
 * Every seat on any of the named accounts, metered or not.
 *
 * A stop on an account's usage wall is the account's own text, not its pool's,
 * so a promotional seat on that account is kept off too. Walls are per task, so
 * these seats are removed from that task's choice only.
 */
export const seatsOnAccounts = (
  seats: ReadonlyArray<Seat>,
  providers: ReadonlyArray<string>,
): ReadonlySet<string> =>
  new Set(
    seats
      .filter((seat) => {
        const provider = providerOf(seat);
        return provider !== undefined && providers.includes(provider);
      })
      .map((seat) => seat.name),
  );

/**
 * The rungs a spent account stops: the dispatchable ones on it whose room that
 * allowance describes.
 */
export const rungsOn = (ladder: Ladder, provider: string): ReadonlyArray<string> =>
  seatsOn(dispatchable(ladder), provider);

/**
 * The seats a spent account stops: those on it whose room that allowance
 * describes.
 *
 * An unmetered seat is left out even though it draws on the same account. The
 * reading is about the metered pool, and a seat fed by a promotional one has
 * room whatever the pool says — so including it would stop work the account can
 * still do.
 */
export const seatsOn = (seats: ReadonlyArray<Seat>, provider: string): ReadonlyArray<string> =>
  seats.filter((seat) => providerOf(seat) === provider && isMetered(seat)).map((seat) => seat.name);
