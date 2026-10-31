import { afterAll, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admit,
  authorStep,
  DEFAULT_POLICY,
  expire,
  grant,
  permit,
  readPolicy,
  updatePolicy,
  type Policy,
} from "./policy.ts";

const withGrants = (...grants: Policy["grants"]): Policy => ({ ...DEFAULT_POLICY, grants });

const scopes = new Map<string, ReadonlySet<string>>([
  ["ep-1", new Set(["ts-a", "ts-b"])],
  ["ts-solo", new Set(["ts-solo"])],
]);

describe("permit", () => {
  test("the default policy allows nothing", () => {
    expect(permit(DEFAULT_POLICY, scopes, "ts-a", "author")._tag).toBe("Denied");
    expect(permit(DEFAULT_POLICY, scopes, "ts-a", "land")._tag).toBe("Denied");
  });

  test("a step on in the default is allowed for every task", () => {
    const policy = { ...DEFAULT_POLICY, default: { ...DEFAULT_POLICY.default, review: true } };
    expect(permit(policy, scopes, "ts-anything", "review")._tag).toBe("Default");
    expect(permit(policy, scopes, "ts-anything", "land")._tag).toBe("Denied");
  });

  test("pause denies every step, the default and grants alike", () => {
    const policy: Policy = {
      ...withGrants({ scope: "ep-1", steps: ["author"], admitted: [] }),
      paused: true,
      default: { author: true, climb: true, review: true, land: true },
    };
    expect(permit(policy, scopes, "ts-a", "author")._tag).toBe("Denied");
    expect(permit(policy, scopes, "ts-x", "review")._tag).toBe("Denied");
  });

  test("an epic grant reaches the tasks under it and no others", () => {
    const policy = withGrants({ scope: "ep-1", steps: ["author"], admitted: [] });
    expect(permit(policy, scopes, "ts-b", "author")).toEqual({
      _tag: "Granted",
      scope: "ep-1",
      admits: true,
    });
    expect(permit(policy, scopes, "ts-outside", "author")._tag).toBe("Denied");
    expect(permit(policy, scopes, "ts-b", "land")._tag).toBe("Denied");
  });

  test("a task grant reaches that task", () => {
    const policy = withGrants({ scope: "ts-solo", steps: ["land"], remaining: 1, admitted: [] });
    expect(permit(policy, scopes, "ts-solo", "land")._tag).toBe("Granted");
  });

  test("a spent count admits no new task, and keeps covering the ones it admitted", () => {
    const policy = withGrants({
      scope: "ep-1",
      steps: ["author", "review", "land"],
      remaining: 1,
      admitted: ["ts-a"],
    });
    expect(permit(policy, scopes, "ts-b", "author")._tag).toBe("Denied");
    // ts-a was authored under the grant, so its review and landing still are.
    expect(permit(policy, scopes, "ts-a", "land")).toEqual({
      _tag: "Granted",
      scope: "ep-1",
      admits: false,
    });
  });
});

describe("admit and expire", () => {
  test("admitting counts a task once", () => {
    const policy = withGrants({ scope: "ep-1", steps: ["author"], remaining: 2, admitted: [] });
    const twice = admit(admit(policy, "ep-1", "ts-a"), "ep-1", "ts-a");
    expect(twice.grants[0]?.admitted).toEqual(["ts-a"]);
  });

  test("a spent grant expires once its admitted tasks are finished", () => {
    const spent = withGrants({
      scope: "ep-1",
      steps: ["author"],
      remaining: 1,
      admitted: ["ts-a"],
    });
    // ts-a still open: the grant still covers its later steps.
    expect(expire(spent, scopes).grants).toHaveLength(1);
    // ts-a finished: nothing left for the grant to do.
    expect(expire(spent, new Map([["ep-1", new Set(["ts-b"])]])).grants).toHaveLength(0);
  });

  test("a grant whose scope holds no unfinished task expires", () => {
    const done = withGrants({ scope: "ts-gone", steps: ["land"], admitted: [] });
    expect(expire(done, new Map([["ts-gone", new Set<string>()]])).grants).toHaveLength(0);
  });

  test("a grant the reading did not see is kept", () => {
    // Added after the tick built its scopes, so the map says nothing about it.
    const added = withGrants({ scope: "ts-new", steps: ["land"], remaining: 1, admitted: [] });
    expect(expire(added, scopes).grants).toHaveLength(1);
  });

  test("an unbounded grant with work left stays", () => {
    const open = withGrants({ scope: "ep-1", steps: ["author"], admitted: ["ts-a", "ts-b"] });
    expect(expire(open, scopes).grants).toHaveLength(1);
  });
});

describe("grant", () => {
  test("a grant given no count keeps the count it had", () => {
    const counted = grant(DEFAULT_POLICY, "ep-1", ["author"], 2);
    expect(grant(counted, "ep-1", ["review"], undefined).grants[0]?.remaining).toBe(2);
  });

  test("a second grant on one scope widens its steps and keeps what it admitted", () => {
    const first = grant(DEFAULT_POLICY, "ep-1", ["author"], 2);
    const admitted = admit(first, "ep-1", "ts-a");
    const widened = grant(admitted, "ep-1", ["land"], 2);
    expect(widened.grants).toEqual([
      { scope: "ep-1", steps: ["author", "land"], remaining: 2, admitted: ["ts-a"] },
    ]);
  });
});

describe("authorStep", () => {
  test("a task with an earlier attempt on record is a climb", () => {
    expect(authorStep([])).toBe("author");
    expect(authorStep(["failed-by:cheap"])).toBe("climb");
    expect(authorStep(["attempt:cheap:1"])).toBe("climb");
  });
});

describe("the policy file", () => {
  const folder = mkdtempSync(join(tmpdir(), "foreman-policy-test-"));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
    Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

  test("a missing file is the default policy", async () => {
    const read = await run(readPolicy(join(folder, "missing.json")));
    expect(read.policy).toEqual(DEFAULT_POLICY);
    expect(read.error).toBeUndefined();
  });

  test("a file that does not decode pauses the fleet and says why", async () => {
    const path = join(folder, "broken.json");
    writeFileSync(path, `{ "slots": "many" }`);
    const read = await run(readPolicy(path));
    expect(read.policy.paused).toBe(true);
    expect(read.error).toContain("does not decode");
  });

  test("an update writes the change whole and leaves no temporary file", async () => {
    const path = join(folder, "policy.json");
    await run(updatePolicy(path, (policy) => ({ ...policy, slots: 5 })));
    await run(updatePolicy(path, (policy) => ({ ...policy, paused: true })));
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.slots).toBe(5);
    expect(written.paused).toBe(true);
    expect(readdirSync(folder).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("an update starts over when the file changed under it", async () => {
    const path = join(folder, "raced.json");
    writeFileSync(path, JSON.stringify({ slots: 2 }));
    let calls = 0;
    await run(
      updatePolicy(path, (policy) => {
        calls += 1;
        // Another writer changes the file after this one read it, once.
        if (calls === 1) writeFileSync(path, JSON.stringify({ slots: 2, paused: true }));
        return { ...policy, slots: 4 };
      }),
    );
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(calls).toBe(2);
    // The other writer's pause survives, and this writer's change is on top.
    expect(written).toMatchObject({ slots: 4, paused: true });
  });

  test("an update refuses a file that does not decode", async () => {
    const path = join(folder, "refused.json");
    writeFileSync(path, "not json");
    const result = await run(Effect.flip(updatePolicy(path, (policy) => policy)));
    expect(result._tag).toBe("PolicyError");
    expect(readFileSync(path, "utf8")).toBe("not json");
  });
});
