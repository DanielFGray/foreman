/**
 * The line an operator command prints when no `foreman serve` runs.
 *
 * Only serve acts on the fleet: a tick settles grants, interventions and
 * releases. A one-shot command writes to the store and returns, so without
 * this line the operator sees a successful write and believes it took effect.
 */
import { Effect, Option } from "effect";
import { serveRunning } from "./serve.ts";

export const SERVE_NOT_RUNNING = "serve is not running; nothing settles until it starts";

/** The notice to print, or none while serve runs. `statePath` is the published reading's file. */
export const serveNotice = (statePath: string) =>
  serveRunning(statePath).pipe(
    Effect.map((running) => (running ? Option.none<string>() : Option.some(SERVE_NOT_RUNNING))),
  );
