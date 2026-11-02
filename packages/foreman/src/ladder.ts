/**
 * The models foreman may use, ordered cheapest first.
 *
 * Order is the rating. There are no price or power numbers to drift out of step
 * with the list, and no map from author to reviewer: the reviewer is the next
 * rung up, and a task that fails a rung records that failure. Both fall out of
 * the order.
 *
 * A task never names the model that runs next. It records which models have
 * already failed it, and the rung is chosen here from what is available now —
 * so retiring a model, or spending its allowance, moves work onto the next one
 * that can take it instead of stranding it. Above the last rung is the
 * operator, who is not an entry in the array: a rung with no harness and no
 * model is a different kind of thing, and an explicit entry invites putting a
 * person in the middle, where every task below them would stall behind
 * somebody asleep.
 */
export type Ladder = readonly [Rung, ...ReadonlyArray<Rung>];

export interface Rung {
  /** How this rung is named in the config, in labels, and on the dashboard. */
  readonly name: string;

  /** The harness kind: the program that runs (see `harnessLaunch`). */
  readonly harness: string;

  /**
   * The model this rung runs. Each harness is told in the way it accepts one —
   * `--model` for claude and codex, a private-server config for opencode — and
   * that mapping lives in `src/harness.ts`, not here. Absent means the
   * harness picks, which is what a rung named after a harness rather than a
   * model wants.
   */
  readonly model: string | undefined;

  /**
   * The account whose allowance this rung spends, where the model does not say.
   *
   * Quota belongs to an account rather than to a rung, so this is what several
   * rungs share when they draw on one plan. Usually derivable — see
   * `providerOf` — and stated only where it is not.
   */
  readonly provider: string | undefined;

  /**
   * Whether foreman may dispatch this rung. Absent means yes.
   *
   * A retired model stays in the ladder, disabled, so it keeps its rank: the
   * failures it recorded still say "cheaper than the rung above was not
   * enough", which is the whole of what a rung means. Deleting the entry
   * instead says the model is no longer part of the rating at all, and the
   * failures naming it stop positioning anything.
   *
   * Optional because retiring a rung is the exception. A rung is written to be
   * used, so only the config that takes one out of service says anything about
   * this at all.
   */
  readonly enabled?: boolean | undefined;

  /**
   * Whether the account's allowance says nothing about this rung's room.
   * Absent means the allowance describes it.
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
  readonly unmetered?: boolean | undefined;

  /**
   * How hard the model thinks: the registry's level for it (`low`, `medium`),
   * or `auto` where the harness decides. The adapter turns it into the flag the
   * harness takes, and passes nothing for a harness that has none.
   */
  readonly thinking?: string | undefined;
}

/** Whether foreman may dispatch a rung: everything but an explicit retirement. */
export const isEnabled = (rung: Rung): boolean => rung.enabled !== false;

/** Whether this rung's room is described by the allowance of its account. */
export const isMetered = (rung: Rung): boolean => rung.unmetered !== true;

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
 * The rung that writes the code next: the cheapest available rung above every
 * rung that has already failed this task.
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
 * `drawn` names the accounts this same tick has already dispatched an author
 * on, and is a preference rather than a wall. Every free slot in one tick reads
 * the same allowances, so without it a tick's whole burst draws on the cheapest
 * funded account until that account dies mid-round — which is a fact about the
 * wallet, answered by the next reading, not by which model happened to be first
 * in the list.
 *
 * It can never turn a `Dispatch` into a `Waiting`: when every affordable rung
 * draws on an account already spent this tick, the cheapest affordable rung is
 * taken anyway. An account that has room is never called spent, and a rung
 * whose account cannot be named is never treated as drawn on.
 */
export const authorFor = (
  ladder: Ladder,
  failures: ReadonlyArray<string>,
  walled: ReadonlySet<string> = new Set(),
  drawn: ReadonlySet<string> = new Set(),
): Choice => {
  const candidates = ladder.slice(floorFor(ladder, failures)).filter(isEnabled);
  const affordable = candidates.filter((candidate) => !walled.has(candidate.name));
  const rung =
    affordable.find((candidate) => !drawn.has(providerOf(candidate) ?? "")) ?? affordable[0];
  if (rung !== undefined) return { _tag: "Dispatch", rung };
  return candidates.length === 0
    ? { _tag: "Yours" }
    : { _tag: "Waiting", walled: candidates.map((candidate) => candidate.name) };
};

/**
 * The lowest rank an author may take: one above the highest-ranked rung that
 * has failed this task.
 *
 * Ranks, not names, so a failure on a rung since retired still holds the work
 * above it as long as that rung keeps its place in the config.
 */
export const floorFor = (ladder: Ladder, failures: ReadonlyArray<string>): number =>
  failures.reduce((floor, failure) => {
    const rank = rankOf(ladder, failure);
    return rank === undefined ? floor : Math.max(floor, rank + 1);
  }, 0);

/** Where a rung sits in the rating, or nothing for one the config has dropped. */
export const rankOf = (ladder: Ladder, name: string): number | undefined => {
  const rank = ladder.findIndex((rung) => rung.name === name);
  return rank < 0 ? undefined : rank;
};

/**
 * The highest-ranked rung a task records as having failed it, which is the one
 * the operator's correction takes back.
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
 * Whether a rung with this many unfinished attempts is spent, so the task
 * records the failure and moves up.
 *
 * An agent that stops without finishing says nothing about its model — a
 * crash, a timeout and a usage wall all end the same way — so the first
 * `attemptsPerRung - 1` failures retry the same rung and the one that reaches
 * `attemptsPerRung` fails it. Judgements never count: a reviewer sending work
 * back, or a branch that broke verification, fails the rung on the strength of
 * the verdict alone.
 */
export const rungSpent = (attempts: number, attemptsPerRung: number): boolean =>
  attempts >= attemptsPerRung;

/**
 * Who reads the work of a given rung, or nothing when no account can pay.
 *
 * The next rung up, so cheap work gets expensive eyes — which is where most of
 * review's value is. The top rung reviews itself: fresh eyes on the same model
 * still catch things, because the reviewer arrives with no sunk cost in the
 * implementation. Work with no author recorded gets the top rung, since nothing
 * says how much judgement it needs.
 *
 * `walled` names the rungs whose account is spent, and the search steps past
 * them to the next rung that can be paid for. An allowance is evidence about a
 * wallet, not about a model, so a spent rung must not stop a diff being read
 * while another account higher up the ladder still has room — that would idle
 * the fleet on money rather than on judgement.
 *
 * **Upward only.** The author's rank records what the work has already earned,
 * and resolving a walled rung downward would silently hand finished work to a
 * model that failed it. Better to leave the review unstarted, which is what
 * `undefined` says: every rung that could read this diff is spent, and the tick
 * passes the task over until an allowance resets.
 *
 * `failed` names rungs whose reviewers already stopped on this task without a
 * verdict; the search starts above the highest of them and the author. When
 * none is left the answer is `undefined` however much allowance remains, so a
 * caller that must tell that from a spent account asks again with no `walled`.
 *
 * Model rungs only. A person intervening in a review takes the pane over; they
 * are never dispatched into one.
 */
export const reviewerFor = (
  ladder: Ladder,
  author: string | undefined,
  walled: ReadonlySet<string> = new Set(),
  failed: ReadonlyArray<string> = [],
): Rung | undefined => {
  // The reviewer must outrank the author and every reviewer that already
  // stopped without a verdict on this task.
  const rankOfName = (name: string) => {
    const rank = rankOf(ladder, name);
    return rank === undefined ? [] : [rank];
  };
  // A name no longer on the ladder positions nothing, so it cannot exhaust it.
  const failedRanks = failed.flatMap(rankOfName);
  const ranks = [...(author === undefined ? [] : rankOfName(author)), ...failedRanks];
  const rank = ranks.length === 0 ? undefined : Math.max(...ranks);
  const above = rank === undefined ? [] : ladder.slice(rank + 1).filter(isEnabled);
  // An unrecognised author and the top rung both fall back to the top, which
  // reviews itself. Only the top's own failure leaves no one: a failed reviewer
  // ranked below the author (the ladder was reordered since) rules out nothing.
  const top = topOf(ladder);
  const candidates = above.length > 0 ? above : failed.includes(top.name) ? [] : [top];
  return candidates.find((rung) => !walled.has(rung.name));
};

/** Reading a hundred files of abandoned work is what cheap models are worst at. */
export const topOf = (ladder: Ladder): Rung => {
  const enabled = ladder.filter(isEnabled);
  return enabled[enabled.length - 1] ?? ladder[0];
};

/** The rungs foreman may dispatch, in rating order — what a chooser offers. */
export const dispatchable = (ladder: Ladder): ReadonlyArray<Rung> => ladder.filter(isEnabled);

/**
 * The account a rung spends, which is what has an allowance.
 *
 * opencode names a model `<provider>/<model>`, so for every rung that names one
 * the account is already written down and stating it again would let the two
 * drift. The claude harness is the one default that is not in doubt — the
 * `claude` binary is always signed into the claude.ai account, however it
 * picks its model — so a rung on it spends `claude` even when it names no
 * model. Any other rung that names no model, or names one without a provider
 * on the front, has to be told; until it is, foreman cannot know whether that
 * rung has room left.
 */
export const providerOf = (rung: Rung): string | undefined => {
  if (rung.provider !== undefined) return rung.provider;
  if (rung.model !== undefined) {
    const [provider, ...rest] = rung.model.split("/");
    if (rest.length > 0 && provider !== undefined && provider.length > 0) return provider;
  }
  return rung.harness === "claude" ? "claude" : undefined;
};

/**
 * Every distinct account the ladder draws on, which is what to ask about.
 *
 * Dispatchable rungs only: a retired rung keeps its rank so old failures still
 * position, but nothing will ever spend its account again, and an allowance
 * nothing can spend is not news.
 *
 * Metered rungs only, for the same reason and the same way: an account whose
 * every rung is fed by a promotional pool is asked nothing, because no reading
 * of it could stop a dispatch. It is probed once per tick, so this saves a
 * request per tick rather than tidying a list.
 */
export const providersOf = (ladder: Ladder): ReadonlyArray<string> => [
  ...new Set(
    dispatchable(ladder)
      .filter(isMetered)
      .flatMap((rung) => {
        const provider = providerOf(rung);
        return provider === undefined ? [] : [provider];
      }),
  ),
];

/**
 * Every rung on any of the named accounts, metered or not.
 *
 * A stop on an account's usage wall is the account's own text, not its pool's,
 * so a promotional rung on that account is kept off too. Walls are per task, so
 * these rungs are removed from that task's author choice only.
 */
export const rungsOnAccounts = (
  ladder: Ladder,
  providers: ReadonlyArray<string>,
): ReadonlySet<string> =>
  new Set(
    ladder
      .filter((rung) => {
        const provider = providerOf(rung);
        return provider !== undefined && providers.includes(provider);
      })
      .map((rung) => rung.name),
  );

/**
 * The rungs a spent account stops: the dispatchable ones on it whose room that
 * allowance describes.
 *
 * An unmetered rung is left out even though it draws on the same account. The
 * reading is about the metered pool, and a rung fed by a promotional one has
 * room whatever the pool says — so including it would stop work the account can
 * still do.
 */
export const rungsOn = (ladder: Ladder, provider: string): ReadonlyArray<string> =>
  dispatchable(ladder)
    .filter((rung) => providerOf(rung) === provider && isMetered(rung))
    .map((rung) => rung.name);
