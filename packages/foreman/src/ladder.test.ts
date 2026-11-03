import { describe, expect, test } from "bun:test";
import {
  authorFor,
  dispatchable,
  floorFor,
  highestFailure,
  type Ladder,
  providerOf,
  providersOf,
  rankOf,
  reviewerFor,
  rungSpent,
  rungsOn,
  topOf,
} from "./ladder.ts";

const rung = (name: string, extra: Partial<Ladder[number]> = {}): Ladder[number] => ({
  name,
  harness: "opencode",
  model: undefined,
  provider: undefined,

  ...extra,
});

const cheap = rung("cheap", { model: "opencode/deepseek-v4-pro" });
const middle = rung("middle", { model: "opencode/claude-sonnet-5" });
const top = rung("top", { harness: "claude" });
const ladder: Ladder = [cheap, middle, top];

describe("authorFor", () => {
  test("starts a task nothing has failed at the bottom", () => {
    const choice = authorFor(ladder, []);
    expect(choice).toEqual({ _tag: "Dispatch", rung: cheap });
  });

  test("takes the cheapest rung above every rung that failed it", () => {
    expect(authorFor(ladder, ["cheap"])).toEqual({ _tag: "Dispatch", rung: middle });
    // Order in the label set says nothing; the highest-ranked failure is the floor.
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
    const oneAccount: Ladder = [cheap, middle];
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
    const retired: Ladder = [cheap, rung("middle", { enabled: false }), top];
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
    const roles: Ladder = [rung("cheap", { author: false }), middle, top];
    expect(authorFor(roles, [])).toEqual({ _tag: "Dispatch", rung: middle });
  });
});

describe("floorFor", () => {
  test("is the rank above the highest-ranked failure", () => {
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
  test("names the failure an operator's correction takes back", () => {
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
    const retired: Ladder = [cheap, rung("middle", { enabled: false }), top];
    expect(dispatchable(retired).map((entry) => entry.name)).toEqual(["cheap", "top"]);
  });
});

describe("rungSpent", () => {
  test("retries in place until the rung's attempts run out", () => {
    // A crash, a timeout and a usage wall say nothing about the model, so the
    // first attemptsPerRung - 1 failures stay on the rung.
    expect(rungSpent(1, 2)).toBe(false);
    expect(rungSpent(2, 3)).toBe(false);
  });

  test("fails the rung on the attempt that reaches the limit", () => {
    expect(rungSpent(2, 2)).toBe(true);
    expect(rungSpent(3, 3)).toBe(true);
    expect(rungSpent(4, 2)).toBe(true);
  });

  test("with attemptsPerRung 1, every stopped run fails the rung", () => {
    expect(rungSpent(1, 1)).toBe(true);
  });
});

describe("reviewerFor", () => {
  test("reads a rung's work with the rung above it", () => {
    expect(reviewerFor(ladder, "cheap")?.name).toBe("middle");
    expect(reviewerFor(ladder, "middle")?.name).toBe("top");
  });

  test("has the top rung review itself rather than dispatching a person", () => {
    // Review stays between agents: a person intervenes by taking the pane over.
    expect(reviewerFor(ladder, "top")?.name).toBe("top");
  });

  test("gives unattributed work to the top, since nothing says it is easy", () => {
    expect(reviewerFor(ladder, undefined)?.name).toBe("top");
  });

  test("never dispatches a retired rung", () => {
    const retired: Ladder = [cheap, rung("middle", { enabled: false }), top];
    expect(reviewerFor(retired, "cheap")?.name).toBe("top");
    expect(topOf(retired)?.name).toBe("top");
  });

  test("reviews with the top of a one-rung ladder", () => {
    const uniform: Ladder = [rung("only")];
    expect(reviewerFor(uniform, "only")?.name).toBe("only");
    expect(topOf(uniform)?.name).toBe("only");
  });

  test("skips a rung whose review role is off", () => {
    const roles: Ladder = [cheap, rung("middle", { review: false }), top];
    expect(reviewerFor(roles, "cheap")?.name).toBe("top");
  });

  test("parks when no review-enabled rung stands above the author", () => {
    const roles: Ladder = [
      cheap,
      rung("middle", { review: false }),
      rung("top", { review: false }),
    ];
    // Cheap is still review-on, but nothing above the author may review — park,
    // rather than handing the author's own work back to itself.
    expect(reviewerFor(roles, "cheap")).toBeUndefined();
    expect(topOf(roles)?.name).toBe("cheap");
  });

  test("has no review top when every rung has review off", () => {
    const none: Ladder = [
      rung("cheap", { review: false }),
      rung("middle", { review: false }),
      rung("top", { review: false }),
    ];
    expect(topOf(none)).toBeUndefined();
    expect(reviewerFor(none, "cheap")).toBeUndefined();
  });

  test("steps past a spent account to the next rung that can be paid for", () => {
    // The wall is the middle rung's account, and the top's is untouched, so the
    // diff is read rather than left waiting on money.
    expect(reviewerFor(ladder, "cheap", new Set(["middle"]))?.name).toBe("top");
  });

  test("never resolves downward, even with every rung above spent", () => {
    // "cheap" already failed this task. Handing the review back to it would
    // spend a rung the work has outgrown, so no review is the honest answer.
    expect(reviewerFor(ladder, "middle", new Set(["top"]))).toBeUndefined();
  });

  test("reads above every reviewer that already stopped without a verdict", () => {
    expect(reviewerFor(ladder, "cheap", new Set(), ["middle"])?.name).toBe("top");
  });

  test("ignores a failed reviewer no longer on the ladder", () => {
    expect(reviewerFor(ladder, "top", new Set(), ["removed"])?.name).toBe("top");
    expect(reviewerFor(ladder, undefined, new Set(), ["removed"])?.name).toBe("top");
  });

  test("has no reviewer once the top rung has stopped, rather than reviewing itself again", () => {
    expect(reviewerFor(ladder, "cheap", new Set(), ["top"])).toBeUndefined();
    expect(reviewerFor(ladder, "top", new Set(), ["top"])).toBeUndefined();
  });

  test("still has the top review a top author's work after a lower reviewer stopped", () => {
    // A reorder can put a reviewer that already stopped below the author.
    expect(reviewerFor(ladder, "top", new Set(), ["cheap"])?.name).toBe("top");
  });

  test("gives no reviewer when every rung at or above is spent", () => {
    expect(reviewerFor(ladder, "cheap", new Set(["middle", "top"]))).toBeUndefined();
  });

  test("gives no reviewer when the top rung that reviews itself is spent", () => {
    expect(reviewerFor(ladder, "top", new Set(["top"]))).toBeUndefined();
    expect(reviewerFor(ladder, undefined, new Set(["top"]))).toBeUndefined();
  });

  test("ignores a wall below the reviewer, which nothing was going to spend", () => {
    expect(reviewerFor(ladder, "cheap", new Set(["cheap"]))?.name).toBe("middle");
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
    const retired: Ladder = [cheap, middle, rung("top", { harness: "claude", enabled: false })];
    expect(providersOf(retired)).toEqual(["opencode"]);
  });

  test("leaves out an account whose every rung is fed by a promotional pool", () => {
    // No reading of it could stop a dispatch, and it is probed once a tick.
    const promo: Ladder = [
      rung("promo", { model: "opencode-go/ox-alpha-free", unmetered: true }),
      rung("sponsored", { model: "opencode-go/kimi-free", unmetered: true }),
    ];
    expect(providersOf(promo)).toEqual([]);
  });

  test("still names an account that also has a metered rung", () => {
    // The metered rung is what makes the reading worth having.
    const mixed: Ladder = [
      rung("promo", { model: "opencode-go/ox-alpha-free", unmetered: true }),
      rung("metered", { model: "opencode-go/kimi-k2.5" }),
    ];
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
    const promo: Ladder = [
      rung("promo", { model: "opencode-go/ox-alpha-free", unmetered: true }),
      rung("metered", { model: "opencode-go/kimi-k2.5" }),
    ];
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
