import { Effect } from "effect";
import { afterEach, describe, expect, it } from "bun:test";
import { logging } from "./log.ts";

const originalConsole = globalThis.console;

afterEach(() => {
  globalThis.console = originalConsole;
});

describe("logging", () => {
  it("uses the current global console once", async () => {
    let writes = 0;
    globalThis.console = {
      ...originalConsole,
      log: () => {
        writes += 1;
      },
    };

    await Effect.logInfo("message").pipe(
      Effect.provide(logging("/tmp/foreman-log-test.jsonl")),
      Effect.runPromise,
    );

    expect(writes).toBe(1);
  });

  it("follows a console replacement after the logger is built", async () => {
    let writes = 0;
    const firstConsole = {
      ...originalConsole,
      log: () => {
        writes += 100;
      },
    };
    const rendererConsole = {
      ...originalConsole,
      log: () => {
        writes += 1;
      },
    };

    globalThis.console = firstConsole;
    const program = Effect.logInfo("message").pipe(
      Effect.provide(logging("/tmp/foreman-log-test.jsonl")),
    );
    globalThis.console = rendererConsole;

    await Effect.runPromise(program);

    expect(writes).toBe(1);
  });
});
