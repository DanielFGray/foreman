import { describe, expect, test } from "bun:test";
import { Array as Arr } from "effect";
import {
  authorFor,
  dispatchable,
  floorFor,
  highestFailure,
  type Ladder,
  providerOf,
  providersOf,
  rankOf,
  levelSpent,
  rungsOn,
} from "./ladder.ts";

const rung = (name: string, extra: Partial<Ladder[number]> = {}): Ladder[number] => ({
  name,
  harness: "opencode",
  model: undefined,
  provider: undefined,
  level: 0,
  enabled: true,
  author: true,
  unmetered: false,
  ...extra,
});

/** The rungs, each alone in its level, cheapest first: the ladder before levels. */
const stacked = (rungs: Ladder): Ladder => Arr.map(rungs, (one, level) => ({ ...one, level }));

const cheap = rung("cheap", { model: "opencode/deepseek-v4-pro" });
const middle = rung("middle", { model: "opencode/claude-sonnet-5", level: 1 });
const top = rung("top", { harness: "claude", level: 2 });
const ladder: Ladder = [cheap, middle, top];

describe("authorFor", () => {
  test("starts a task nothing has failed at the bottom", () => {
    const choice = authorFor(ladder, []);
    expect(choice).toEqual({ _tag: "Dispatch", rung: cheap });
  });

  test("takes the cheapest rung above every rung that failed it", () => {
    expect(authorFor(ladder, ["cheap"])).toEqual({ _tag: "Dispatch", rung: middle });
    // Order among the charged rungs says nothing; the highest-ranked failure is the floor.
    expect(authorFor(ladder, ["middle", "cheap"])).toEqual({ _tag: "Dispatch", rung: top });
  });

  test("hands a task every rung has failed to the operator", () => {
    expect(authorFor(ladder, ["cheap", "middle", "top"])).toEqual({ _tag: "Yours" });
  });

  test("steps over an account this same tick is already spending", () => {
    // The two cheapest rungs share one account and the third does not, so a burst
    // that took the cheapest again would run the whole tick off one wallet.
    expect(authorFor(ladder, [], new Set(), new Set(["opencode"]))).toEqual({
      _tag: "Dispatch",
      rung: top,
    });
  });

  test("takes the ordinary rung when every account is already being spent", () => {
    // A preference and never a wall: an account with room is not spent, and a
    // task must not wait for a reset that nothing is waiting on.
    const oneAccount: Ladder = stacked([cheap, middle]);
    expect(authorFor(oneAccount, [], new Set(), new Set(["opencode"]))).toEqual({
      _tag: "Dispatch",
      rung: cheap,
    });
  });

  test("ignores a failure naming a rung the config has dropped", () => {
    // Deleting the entry outright says the model is no longer part of the
    // rating, so what it recorded cannot position anything.
    expect(authorFor(ladder, ["retired"])).toEqual({ _tag: "Dispatch", rung: cheap });
  });

  test("keeps the floor a retired rung earned while it holds its rank", () => {
    // The whole point of `enabled: false`: the rung is never dispatched, but
    // work that outgrew it must not drop back below it.
    const retired: Ladder = stacked([cheap, rung("middle", { enabled: false }), top]);
    expect(authorFor(retired, ["middle"])).toEqual({ _tag: "Dispatch", rung: top });
    expect(authorFor(retired, ["cheap"])).toEqual({ _tag: "Dispatch", rung: top });
  });

  test("steps over a spent account to a rung that can pay", () => {
    // An allowance is evidence about a wallet, never about a model, so nothing
    // is recorded and the task simply runs dearer this tick.
    expect(authorFor(ladder, [], new Set(["cheap"]))).toEqual({
      _tag: "Dispatch",
      rung: middle,
    });
  });

  test("waits, rather than parking on the operator, when only money is missing", () => {
    // The two must not collapse: this one clears itself when the account
    // resets, and no decision the operator can write changes it.
    expect(authorFor(ladder, [], new Set(["cheap", "middle", "top"]))).toEqual({
      _tag: "Waiting",
      walled: ["cheap", "middle", "top"],
    });
    expect(authorFor(ladder, ["cheap", "middle"], new Set(["top"]))).toEqual({
      _tag: "Waiting",
      walled: ["top"],
    });
  });

  test("skips a rung whose author role is off", () => {
    const roles: Ladder = stacked([rung("cheap", { author: false }), middle, top]);
    expect(authorFor(roles, [])).toEqual({ _tag: "Dispatch", rung: middle });
  });
});

describe("authorFor across a level", () => {
  // Three peers between a bottom and a top level.
  const low = rung("low");
  const one = rung("one", { level: 1 });
  const two = rung("two", { level: 1 });
  const three = rung("three", { level: 1 });
  const high = rung("high", { harness: "claude", level: 2 });
  const levels: Ladder = [low, one, two, three, high];
  const at = (ms: number) => new Date(ms);

  test("takes the peer whose last start is oldest", () => {
    const starts = new Map([
      ["one", at(3000)],
      ["two", at(1000)],
      ["three", at(2000)],
    ]);
    expect(authorFor(levels, ["low"], new Set(), new Set(), starts)).toEqual({
      _tag: "Dispatch",
      rung: two,
    });
  });

  test("takes a peer that never started before one that has", () => {
    const starts = new Map([["one", at(1000)]]);
    expect(authorFor(levels, ["low"], new Set(), new Set(), starts)).toEqual({
      _tag: "Dispatch",
      rung: two,
    });
  });

  test("takes the peers in rank order when no run has started", () => {
    expect(authorFor(levels, ["low"])).toEqual({ _tag: "Dispatch", rung: one });
  });

  test("keeps a lower level ahead of an older start", () => {
    const starts = new Map([
      ["low", at(5000)],
      ["one", at(1000)],
    ]);
    expect(authorFor(levels, [], new Set(), new Set(), starts)).toEqual({
      _tag: "Dispatch",
      rung: low,
    });
  });

  test("climbs past the whole level on one failure in it", () => {
    expect(authorFor(levels, ["two"])).toEqual({ _tag: "Dispatch", rung: high });
    expect(floorFor(levels, ["two"])).toBe(2);
    expect(highestFailure(levels, ["low", "three"])).toBe("three");
  });
});

describe("floorFor", () => {
  test("is the level above the highest failed level", () => {
    expect(floorFor(ladder, [])).toBe(0);
    expect(floorFor(ladder, ["cheap"])).toBe(1);
    expect(floorFor(ladder, ["cheap", "middle"])).toBe(2);
    expect(floorFor(ladder, ["unknown"])).toBe(0);
  });
});

describe("rankOf", () => {
  test("places a configured rung and nothing else", () => {
    expect(rankOf(ladder, "middle")).toBe(1);
    expect(rankOf(ladder, "retired")).toBeUndefined();
  });
});

describe("highestFailure", () => {
  test("names a failure at the level an operator's correction takes back", () => {
    expect(highestFailure(ladder, ["cheap", "middle"])).toBe("middle");
    expect(highestFailure(ladder, [])).toBeUndefined();
  });

  test("skips a failure that cannot be positioned", () => {
    // It is holding the task nowhere, so removing it would correct nothing.
    expect(highestFailure(ladder, ["cheap", "retired"])).toBe("cheap");
    expect(highestFailure(ladder, ["retired"])).toBeUndefined();
  });
});

describe("dispatchable", () => {
  test("offers only the rungs that can run", () => {
    const retired: Ladder = stacked([cheap, rung("middle", { enabled: false }), top]);
    expect(dispatchable(retired).map((entry) => entry.name)).toEqual(["cheap", "top"]);
  });
});

describe("levelSpent", () => {
  test("retries in place until the rung's attempts run out", () => {
    // A crash, a timeout and a usage wall say nothing about the model, so the
    // first attemptsPerLevel - 1 failures stay on the rung.
    expect(levelSpent(1, 2)).toBe(false);
    expect(levelSpent(2, 3)).toBe(false);
  });

  test("fails the rung on the attempt that reaches the limit", () => {
    expect(levelSpent(2, 2)).toBe(true);
    expect(levelSpent(3, 3)).toBe(true);
    expect(levelSpent(4, 2)).toBe(true);
  });

  test("with attemptsPerLevel 1, every stopped run fails the rung", () => {
    expect(levelSpent(1, 1)).toBe(true);
  });
});

describe("providerOf", () => {
  test("reads the account off the model's provider prefix", () => {
    expect(providerOf(cheap)).toBe("opencode");
  });

  test("prefers what the config states over what the model implies", () => {
    // The two can legitimately disagree: a gateway serves another vendor's
    // model under its own account, and it is the account that has the quota.
    expect(
      providerOf(
        rung("gateway", { model: "openrouter/gpt-5.6-luna", provider: "openrouter-work" }),
      ),
    ).toBe("openrouter-work");
  });

  test("names no account for a rung that is only a generic harness", () => {
    // `opencode` running whatever it defaults to could be signed in to
    // anything, so nothing here can say whose allowance it spends.
    expect(providerOf(rung("top"))).toBeUndefined();
  });

  test("reads the claude account from the claude harness", () => {
    // The claude binary is always signed into the claude.ai account, however
    // it picks its model, so the harness names the account where the model
    // does not.
    expect(providerOf(rung("top", { harness: "claude" }))).toBe("claude");
    expect(providerOf(rung("sonnet", { harness: "claude", model: "sonnet" }))).toBe("claude");
  });

  test("names no account for a model with no provider on the front", () => {
    // A bare model id is the harness's own default provider, which the harness
    // never tells us. Reading it as a provider called "gpt-5" would ask a
    // question no probe can answer.
    expect(providerOf(rung("bare", { model: "gpt-5" }))).toBeUndefined();
  });
});

describe("providersOf", () => {
  test("names each account once, however many rungs draw on it", () => {
    expect(providersOf(ladder)).toEqual(["opencode", "claude"]);
  });

  test("leaves out an account only a retired rung spends", () => {
    // Nothing will spend it again, and an allowance nothing can spend is not
    // news the operator has to read every tick.
    const retired: Ladder = stacked([
      cheap,
      middle,
      rung("top", { harness: "claude", enabled: false }),
    ]);
    expect(providersOf(retired)).toEqual(["opencode"]);
  });

  test("leaves out an account whose every rung is fed by a promotional pool", () => {
    // No reading of it could stop a dispatch, and it is probed once a tick.
    const promo: Ladder = stacked([
      rung("promo", { model: "opencode-go/ox-alpha-free", unmetered: true }),
      rung("sponsored", { model: "opencode-go/kimi-free", unmetered: true }),
    ]);
    expect(providersOf(promo)).toEqual([]);
  });

  test("still names an account that also has a metered rung", () => {
    // The metered rung is what makes the reading worth having.
    const mixed: Ladder = stacked([
      rung("promo", { model: "opencode-go/ox-alpha-free", unmetered: true }),
      rung("metered", { model: "opencode-go/kimi-k2.5" }),
    ]);
    expect(providersOf(mixed)).toEqual(["opencode-go"]);
  });
});

describe("rungsOn", () => {
  test("names every rung a spent account stops", () => {
    // The point of the whole reading: one exhausted account takes out every
    // rung behind it, so climbing within it buys nothing.
    expect(rungsOn(ladder, "opencode")).toEqual(["cheap", "middle"]);
    expect(rungsOn(ladder, "claude")).toEqual(["top"]);
  });

  test("leaves out a rung the account's percentage does not describe", () => {
    // The one false wall there is. A promotional model draws on another pool,
    // so walling it on the metered percentage passes over work the account can
    // still pay for, and the task waits for a reset that was never relevant.
    const promo: Ladder = stacked([
      rung("promo", { model: "opencode-go/ox-alpha-free", unmetered: true }),
      rung("metered", { model: "opencode-go/kimi-k2.5" }),
    ]);
    expect(rungsOn(promo, "opencode-go")).toEqual(["metered"]);
  });

  test("stops nothing on an account whose rungs are all unmetered", () => {
    expect(
      rungsOn(
        [rung("promo", { model: "opencode-go/ox-alpha-free", unmetered: true })],
        "opencode-go",
      ),
    ).toEqual([]);
  });
});
