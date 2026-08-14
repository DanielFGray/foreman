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
 * The screen copy replaces Effect's default logger rather than joining it,
 * which is the whole reason this layer exists. Creating an opentui renderer
 * assigns a NEW object to globalThis.console and routes it to the F12 overlay.
 * Effect resolved the old object when it loaded and holds that reference, so
 * its own logger keeps writing to the real stdout — underneath a full-screen
 * renderer, which scribbles log lines across the frame until the next repaint.
 * Reading globalThis.console per line follows the swap instead: under the
 * dashboard the text lands in the overlay, and in plan mode, where no renderer
 * ever swapped it, on the terminal. Same line, no mode to choose.
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
      // No time on this copy. The overlay stamps every line it shows, so
      // carrying one here reads as `[10:45:40] [LOG] '10:45:40 INFO ...'`, and
      // plan mode is a foreground run somebody is watching, where the clock is
      // noise. The durable timestamp is the file's. The level does stay: the
      // overlay labels everything LOG, so a warning is otherwise invisible.
      globalThis.console.log(`${logLevel.label} ${text}`);
    }),
  ).pipe(Layer.tap(() => Effect.sync(() => mkdirSync(dirname(path), { recursive: true }))));

const defaultPath = (): string =>
  process.env["FOREMAN_LOG"] ??
  join(
    process.env["XDG_STATE_HOME"] ?? join(process.env["HOME"] ?? "", ".local", "state"),
    "foreman",
    "foreman.jsonl",
  );
