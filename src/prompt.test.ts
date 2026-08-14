import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Prompts } from "./prompt.ts";
import type { Item } from "./prog.ts";

const item: Item = {
  id: "ts-123456",
  title: "Adopt uncommitted work in foreman",
  status: "in_progress",
  project: "foreman",
  type: "task",
  priority: 2,
  labels: ["onboard"],
  last_activity_at: new Date(),
};

const ready = {
  id: "ts-123456",
  title: "Test task",
  priority: 3,
  project: "foreman",
  labels: [],
} as const;

describe("Prompts", () => {
  test("gives an unreviewed author the landing checkout", async () => {
    const prompt = await Effect.runPromise(
      Effect.gen(function* () {
        const prompts = yield* Prompts;
        return yield* prompts.author(ready, "/tmp/worktree", "/tmp/repository", false);
      }).pipe(Effect.provide(Prompts.Default)),
    );

    expect(prompt).toContain("git -C /tmp/repository merge --no-ff foreman/ts-123456");
  });

  test("asks a successful reviewer for a verdict, not a merge", async () => {
    const prompt = await Effect.runPromise(
      Effect.gen(function* () {
        const prompts = yield* Prompts;
        return yield* prompts.review(item, "/tmp/worktree", "/tmp/repository");
      }).pipe(Effect.provide(Prompts.Default)),
    );

    expect(prompt).toContain("prog label ts-123456 approved");
    expect(prompt).not.toContain("git -C /tmp/repository merge");
    expect(prompt).not.toContain("prog done ts-123456");
  });

  test("sends an onboarding agent to the checkout and back off it", async () => {
    const prompt = await Effect.runPromise(
      Effect.gen(function* () {
        const prompts = yield* Prompts;
        return yield* prompts.onboard(item, "/tmp/repository");
      }).pipe(Effect.provide(Prompts.Default)),
    );

    expect(prompt).toContain("git -C /tmp/repository checkout -b foreman/ts-123456");
    // The whole safety of the run rests on the operator's branch ending where
    // they left it, so the instruction to return to it is asserted, not assumed.
    expect(prompt).toContain("git -C /tmp/repository checkout -\n");
  });
});
