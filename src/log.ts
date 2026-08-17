import { Cause, Effect, Layer, Logger } from "effect";
import { appendFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Every line foreman logs, written twice: once to a file, once to the screen.
 *
 * The file is the durable copy. The pane a daemon runs in is not a log — it
 * scrolls, and it dies with the session — but the questions worth asking about
 * an unattended fleet are all asked long after the event: why did this task go
 * to that model, why was this claim released, what did it do at 3am. One JSON
 * object per line, so the answer is a jq query rather than a full read.
 *
 * The screen copy replaces Effect's default logger rather than joining it.
 * OpenTUI replaces globalThis.console when its renderer starts, so reading it
 * at log time sends dashboard records to the F12 overlay instead of stdout.
 */
export const logging = (path = defaultPath()): Layer.Layer<never> =>
  Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ date, logLevel, message, cause }) => {
      const said = Array.isArray(message) ? message.map(String).join(" ") : String(message);
      // A fiber that dies logs an empty message and puts everything in the
      // cause. Reading only the message wrote a blank ERROR line for every
      // crash foreman ever had — the one event the file exists to explain.
      const text = [said, Cause.isEmpty(cause) ? "" : Cause.pretty(cause)]
        .filter((part) => part !== "")
        .join("\n");
      // Synchronous on purpose: a crash must not lose the lines that explain
      // it, and foreman writes a handful of lines per tick, not a stream.
      appendFileSync(
        path,
        `${JSON.stringify({ at: date.toISOString(), level: logLevel.label, message: text })}\n`,
      );
      console.log(`${logLevel.label} ${text}`);
    }),
  ).pipe(Layer.tap(() => Effect.sync(() => mkdirSync(dirname(path), { recursive: true }))));

const defaultPath = (): string =>
  process.env["FOREMAN_LOG"] ??
  join(
    process.env["XDG_STATE_HOME"] ?? join(process.env["HOME"] ?? "", ".local", "state"),
    "foreman",
    "foreman.jsonl",
  );
