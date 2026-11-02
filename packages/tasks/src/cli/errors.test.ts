import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { TaskError } from "../store.ts";
import { refusals } from "./errors.ts";

afterEach(() => {
  process.exitCode = 0;
});

test("a refused command prints one line and sets exit code 1", async () => {
  const printed: Array<string> = [];
  const original = console.error;
  console.error = (...parts: Array<unknown>) => void printed.push(parts.join(" "));
  try {
    await Effect.runPromise(
      refusals.TaskError(
        new TaskError({ id: "ts-abc123", detail: "cannot start an item that is done" }),
      ),
    );
  } finally {
    console.error = original;
  }
  expect(printed).toEqual(["error: ts-abc123: cannot start an item that is done"]);
  expect(process.exitCode).toBe(1);
});
