import { Effect, Layer, Logger } from "effect";
import { appendFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Where foreman records what it decided.
 *
 * The pane a daemon runs in is not a log: it scrolls, and it dies with the
 * session. Every dispatch, reclaim, return and escalation has to be readable
 * afterwards, because the questions worth asking about an unattended fleet —
 * why did this task go to that model, why was this claim released, what did it
 * do at 3am — are all asked long after the event.
 *
 * Written as one JSON object per line so the file can be queried with jq
 * rather than read in full.
 */
export const fileLogger = (path = defaultPath()): Layer.Layer<never> =>
  // Added rather than swapped in: the runtime already prints to the pane, and
  // the pane is still where an operator watches a live fleet. This is the
  // second copy, the one that outlives the session.
  Logger.add(
    Logger.make(({ date, logLevel, message }) => {
      const line = JSON.stringify({
        at: date.toISOString(),
        level: logLevel.label,
        message: Array.isArray(message) ? message.map(String).join(" ") : String(message),
      });
      // Synchronous on purpose: a crash must not lose the lines that explain
      // it, and foreman writes a handful of lines per tick, not a stream.
      appendFileSync(path, `${line}\n`);
    }),
  ).pipe(Layer.tap(() => Effect.sync(() => mkdirSync(dirname(path), { recursive: true }))));

const defaultPath = (): string =>
  process.env["FOREMAN_LOG"] ??
  join(
    process.env["XDG_STATE_HOME"] ?? join(process.env["HOME"] ?? "", ".local", "state"),
    "foreman",
    "foreman.jsonl",
  );
