import { afterAll, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Schema as S } from "effect";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admit,
  checkoutFor,
  clearProject,
  DEFAULT_POLICY,
  expire,
  grant,
  modeOf,
  pauseProject,
  permit,
  Policy,
  readPolicy,
  setProjectCheckout,
  setProjectStep,
  updatePolicy,
} from "./policy.ts";

const withGrants = (...grants: Policy["grants"]): Policy => ({ ...DEFAULT_POLICY, grants });

const task = (id: string, project = "alpha") => ({ id, project });

const scopes = new Map<string, ReadonlySet<string>>([
  ["ep-1", new Set(["ts-a", "ts-b"])],
  ["ts-solo", new Set(["ts-solo"])],
]);

describe("modeOf", () => {
  const solo = { scope: "ts-solo", steps: ["land" as const], admitted: [] };

  test("a fleet with no step on and no grant is idle", () => {
    expect(modeOf(DEFAULT_POLICY)).toBe("idle");
  });

  test("one default step or one grant makes it running", () => {
    expect(
      modeOf({ ...DEFAULT_POLICY, default: { ...DEFAULT_POLICY.default, review: "on" } }),
    ).toBe("running");
    expect(modeOf(withGrants(solo))).toBe("running");
  });

  test("an ask step makes the fleet running, since it reports work", () => {
    expect(modeOf({ ...DEFAULT_POLICY, default: { ...DEFAULT_POLICY.default, land: "ask" } })).toBe(
      "running",
    );
  });

  test("an off step is not a running step", () => {
    expect(modeOf({ ...DEFAULT_POLICY, default: { ...DEFAULT_POLICY.default, land: "off" } })).toBe(
      "idle",
    );
  });

  test("a pause wins over every step and grant", () => {
    const everything: Policy = {
      ...withGrants(solo),
      default: { author: "on", climb: "on", review: "on", land: "on" } as const,
    };
    expect(modeOf({ ...everything, paused: true })).toBe("paused");
  });
});

describe("permit", () => {
  test("the default policy allows nothing", () => {
    expect(permit(DEFAULT_POLICY, scopes, task("ts-a"), "author")._tag).toBe("Denied");
    expect(permit(DEFAULT_POLICY, scopes, task("ts-a"), "land")._tag).toBe("Denied");
  });

  test("a step on in the default is allowed for every task", () => {
    const policy: Policy = {
      ...DEFAULT_POLICY,
      default: { ...DEFAULT_POLICY.default, review: "on" },
    };
    expect(permit(policy, scopes, task("ts-anything"), "review")._tag).toBe("Default");
    expect(permit(policy, scopes, task("ts-anything"), "land")._tag).toBe("Denied");
  });

  test("a step set to ask is Ask for every task no grant covers", () => {
    const policy: Policy = {
      ...DEFAULT_POLICY,
      default: { ...DEFAULT_POLICY.default, review: "ask" },
    };
    expect(permit(policy, scopes, task("ts-anything"), "review")._tag).toBe("Ask");
    expect(permit(policy, scopes, task("ts-anything"), "land")._tag).toBe("Denied");
  });

  test("a grant covering an asked step takes effect before the ask", () => {
    const policy: Policy = {
      ...withGrants({ scope: "ts-solo", steps: ["review"], remaining: 1, admitted: [] }),
      default: { ...DEFAULT_POLICY.default, review: "ask" },
    };
    expect(permit(policy, scopes, task("ts-solo"), "review")).toEqual({
      _tag: "Granted",
      scope: "ts-solo",
      admits: true,
    });
    expect(permit(policy, scopes, task("ts-other"), "review")._tag).toBe("Ask");
  });

  test("pause denies an asked step too", () => {
    const policy: Policy = {
      ...DEFAULT_POLICY,
      paused: true,
      default: { ...DEFAULT_POLICY.default, review: "ask" },
    };
    expect(permit(policy, scopes, task("ts-a"), "review")._tag).toBe("Denied");
  });

  test("pause denies every step, the default and grants alike", () => {
    const policy: Policy = {
      ...withGrants({ scope: "ep-1", steps: ["author"], admitted: [] }),
      paused: true,
      default: { author: "on", climb: "on", review: "on", land: "on" } as const,
    };
    expect(permit(policy, scopes, task("ts-a"), "author")._tag).toBe("Denied");
    expect(permit(policy, scopes, task("ts-x"), "review")._tag).toBe("Denied");
  });

  test("an epic grant reaches the tasks under it and no others", () => {
    const policy = withGrants({ scope: "ep-1", steps: ["author"], admitted: [] });
    expect(permit(policy, scopes, task("ts-b"), "author")).toEqual({
      _tag: "Granted",
      scope: "ep-1",
      admits: true,
    });
    expect(permit(policy, scopes, task("ts-outside"), "author")._tag).toBe("Denied");
    expect(permit(policy, scopes, task("ts-b"), "land")._tag).toBe("Denied");
  });

  test("a task grant reaches that task", () => {
    const policy = withGrants({ scope: "ts-solo", steps: ["land"], remaining: 1, admitted: [] });
    expect(permit(policy, scopes, task("ts-solo"), "land")._tag).toBe("Granted");
  });

  test("a spent count admits no new task, and keeps covering the ones it admitted", () => {
    const policy = withGrants({
      scope: "ep-1",
      steps: ["author", "review", "land"],
      remaining: 1,
      admitted: ["ts-a"],
    });
    expect(permit(policy, scopes, task("ts-b"), "author")._tag).toBe("Denied");
    // ts-a was authored under the grant, so its review and landing still are.
    expect(permit(policy, scopes, task("ts-a"), "land")).toEqual({
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

describe("per-project settings", () => {
  const onFor = (project: string, steps: Policy["projects"][string]["steps"]): Policy => ({
    ...DEFAULT_POLICY,
    projects: { [project]: { steps } },
  });

  test("a project override wins over the default, in both directions", () => {
    const policy: Policy = {
      ...onFor("alpha", { author: "on" }),
      default: { ...DEFAULT_POLICY.default, review: "on" },
    };
    expect(permit(policy, scopes, task("ts-x", "alpha"), "author")._tag).toBe("Default");
    expect(permit(policy, scopes, task("ts-x", "beta"), "author")._tag).toBe("Denied");
    const quiet = {
      ...policy,
      projects: { alpha: { steps: { review: "off" as const } } },
    };
    expect(permit(quiet, scopes, task("ts-x", "alpha"), "review")._tag).toBe("Denied");
    expect(permit(quiet, scopes, task("ts-x", "beta"), "review")._tag).toBe("Default");
  });

  test("an override to ask holds the project's task for approval", () => {
    expect(
      permit(onFor("alpha", { land: "ask" }), scopes, task("ts-x", "alpha"), "land")._tag,
    ).toBe("Ask");
  });

  test("an unset project follows the default", () => {
    const policy: Policy = {
      ...onFor("alpha", { author: "off" }),
      default: { ...DEFAULT_POLICY.default, author: "on" },
    };
    expect(permit(policy, scopes, task("ts-x", "gamma"), "author")._tag).toBe("Default");
    expect(permit(policy, scopes, task("ts-x", "alpha"), "climb")._tag).toBe("Denied");
  });

  test("a paused project denies every step, even with a grant", () => {
    const policy: Policy = {
      ...withGrants({ scope: "ts-solo", steps: ["land"], admitted: [] }),
      default: { ...DEFAULT_POLICY.default, author: "on" },
      projects: { alpha: { paused: true } },
    };
    expect(permit(policy, scopes, task("ts-solo", "alpha"), "land")._tag).toBe("Denied");
    expect(permit(policy, scopes, task("ts-x", "alpha"), "author")._tag).toBe("Denied");
    expect(permit(policy, scopes, task("ts-solo", "beta"), "land")._tag).toBe("Granted");
  });

  test("the global pause wins over a project that is running", () => {
    const policy = { ...onFor("alpha", { author: "on" }), paused: true };
    expect(permit(policy, scopes, task("ts-x", "alpha"), "author")._tag).toBe("Denied");
    expect(modeOf(policy)).toBe("paused");
  });

  test("modeOf is running with only a project override on", () => {
    expect(modeOf(onFor("alpha", { author: "on" }))).toBe("running");
    expect(modeOf(onFor("alpha", { author: "ask" }))).toBe("running");
  });

  test("modeOf is idle when overrides are off or their project is paused", () => {
    expect(modeOf(onFor("alpha", { author: "off" }))).toBe("idle");
    expect(
      modeOf({ ...DEFAULT_POLICY, projects: { alpha: { paused: true, steps: { author: "on" } } } }),
    ).toBe("idle");
  });

  test("edits set, pause, resume and clear one project, dropping an emptied entry", () => {
    let policy = setProjectStep(DEFAULT_POLICY, "alpha", "author", "on");
    policy = setProjectStep(policy, "alpha", "land", "ask");
    policy = pauseProject(policy, "alpha", true);
    expect(policy.projects).toEqual({
      alpha: { paused: true, steps: { author: "on", land: "ask" } },
    });
    expect(pauseProject(policy, "alpha", false).projects["alpha"]?.paused).toBeUndefined();
    expect(clearProject(policy, "alpha").projects).toEqual({});
    expect(pauseProject(DEFAULT_POLICY, "alpha", false).projects).toEqual({});
  });

  test("a project's checkout is worktree unless set, and setting worktree drops the entry", () => {
    expect(checkoutFor(DEFAULT_POLICY, "alpha")).toBe("worktree");
    const branch = setProjectCheckout(DEFAULT_POLICY, "alpha", "branch");
    expect(branch.projects).toEqual({ alpha: { checkout: "branch" } });
    expect(checkoutFor(branch, "alpha")).toBe("branch");
    expect(checkoutFor(branch, "beta")).toBe("worktree");
    expect(setProjectCheckout(branch, "alpha", "worktree").projects).toEqual({});
  });

  test("a policy file without projects decodes with none", async () => {
    const decoded = await Effect.runPromise(
      S.decodeEffect(S.fromJsonString(Policy))(JSON.stringify({ slots: 2 })),
    );
    expect(decoded.projects).toEqual({});
  });
});
