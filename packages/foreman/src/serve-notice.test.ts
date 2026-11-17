import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Option } from "effect";
import { SERVE_NOT_RUNNING, serveNotice } from "./serve-notice.ts";
import { holdLock, lockPath } from "./serve.ts";

const withState = async (body: (state: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "serve-notice-"));
  try {
    await body(join(dir, "state.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

describe("serveNotice", () => {
  test("is none while a serve holds the lock beside the state file", async () => {
    await withState(async (state) => {
      const notice = await run(
        Effect.scoped(holdLock(lockPath(state)).pipe(Effect.andThen(serveNotice(state)))),
      );
      expect(notice).toEqual(Option.none());
    });
  });

  test("says serve is not running when no serve holds the lock", async () => {
    await withState(async (state) => {
      expect(await run(serveNotice(state))).toEqual(Option.some(SERVE_NOT_RUNNING));
    });
  });
});
