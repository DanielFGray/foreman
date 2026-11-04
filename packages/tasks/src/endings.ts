/**
 * How an agent's run stopped with no exit named. Foreman observes these:
 * `stopped` (the agent ended without naming an exit), `vanished`, `walled`,
 * `released` and `canceled`. An operator never declares them.
 *
 * A module of its own because the migrations write these into the runs
 * table's CHECK, and the runs module reaches the migrations through the store.
 */
export const PROCESS_ENDINGS = ["stopped", "vanished", "walled", "released", "canceled"] as const;
export type ProcessEnding = (typeof PROCESS_ENDINGS)[number];

/**
 * The form of an exit's name and of its id. A run stores the id of the exit it
 * named as its ending, so an ending in this form that is no process ending is
 * an exit.
 */
export const EXIT_NAME = /^[a-z-]+$/;
