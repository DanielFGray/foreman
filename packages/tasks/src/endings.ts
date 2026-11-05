/**
 * How an agent's run stopped with no exit named. Foreman observes these:
 * `stopped` (the agent ended without naming an exit), `vanished`, `walled`,
 * `released` and `canceled`. An operator never declares them.
 *
 * A module of its own because the migrations write these into the runs
 * table's CHECK, and the runs module reaches the migrations through the store.
 */
import { Schema as S } from "effect";

export const PROCESS_ENDINGS = ["stopped", "vanished", "walled", "released", "canceled"] as const;
export const ProcessEnding = S.Literals(PROCESS_ENDINGS);
export type ProcessEnding = typeof ProcessEnding.Type;

/**
 * The form of an exit's name and of its id. A run stores the id of the exit it
 * named as its ending, so an ending in this form that is no process ending is
 * an exit.
 */
export const EXIT_NAME = /^[a-z-]+$/;

/**
 * How a run ended: an exit the agent named, or a process ending. Both share
 * the same spelling; `isExit` tells them apart. The store accepts any exit
 * name for an agent run, because only foreman knows the block the run was at
 * and which exits it declares.
 */
export const Ending = S.String.check(
  S.isPattern(EXIT_NAME, { description: "ending (lowercase letters and hyphens)" }),
);
export type Ending = typeof Ending.Type;

/** Whether `ending` names an exit, rather than how a process stopped. */
export const isExit = (ending: Ending): boolean =>
  !(PROCESS_ENDINGS as ReadonlyArray<string>).includes(ending);
