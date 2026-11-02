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
