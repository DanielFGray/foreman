import { Console, Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { TaskError } from "../store.ts";

/**
 * Handlers for the errors a caller can cause: each prints one line on stderr
 * and sets exit code 1. A stack trace would tell the caller nothing the line
 * does not. Pass to `Effect.catchTags`.
 */
export const refusals = {
  TaskError: (error: TaskError) => fail(`${error.id}: ${error.detail}`),
  SqlError: (error: SqlError) => fail(`store: ${error.message}`),
};

const fail = (line: string) =>
  Console.error(`error: ${line}`).pipe(
    Effect.andThen(Effect.sync(() => void (process.exitCode = 1))),
  );
