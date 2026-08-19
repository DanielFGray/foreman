import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { Cause, Effect, Layer, Logger } from "effect";

/**
 * Every line foreman logs, written to one file and nowhere else.
 *
 * The questions worth asking about an unattended fleet are all asked long
 * after the event: why did this task go to that model, why was this claim
 * released, what did it do at 3am. One JSON object per line, so the answer is
 * a jq query rather than a full read.
 *
 * It replaces Effect's default logger rather than joining it, because the
 * dashboard owns the terminal for as long as it runs and a second logger
 * writing underneath it would tear the screen. The dashboard reads this file
 * back to show the log instead.
 */
export const logging = (path = logPath()): Layer.Layer<never> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const stream = yield* Effect.promise(async () => {
        await mkdir(dirname(path), { recursive: true });
        return createWriteStream(path, { flags: "a" });
      });

      return Logger.replace(
        Logger.defaultLogger,
        Logger.make(({ date, logLevel, message, cause }) => {
          const said = Array.isArray(message) ? message.map(String).join(" ") : String(message);
          // A fiber that dies logs an empty message and puts everything in the
          // cause. Reading only the message wrote a blank ERROR line for every
          // crash foreman ever had — the one event the file exists to explain.
          const text = [said, Cause.isEmpty(cause) ? "" : Cause.pretty(cause)]
            .filter((part) => part !== "")
            .join("\n");
          // Keep one stream so log records stay ordered without forking a fiber
          // from the synchronous logger callback.
          stream.write(
            `${JSON.stringify({ at: date.toISOString(), level: logLevel.label, message: text })}\n`,
          );
        }),
      );
    }),
  );

/** Where the log is, for the dashboard that reads it back. */
export const logPath = (): string => {
  const stateHome = process.env["XDG_STATE_HOME"] ?? `${process.env["HOME"] ?? ""}/.local/state`;
  return process.env["FOREMAN_LOG"] ?? `${stateHome}/foreman/foreman.jsonl`;
};
