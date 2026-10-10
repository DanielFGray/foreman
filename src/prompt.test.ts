import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Prompts } from "./prompt.ts";
import type { Item } from "./prog.ts";

const run = <A, E>(f: (prompts: Prompts["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Prompts.use(f).pipe(Effect.provide(Prompts.Default)));

const item: Item = {
  id: "ts-123456",
  title: "Adopt uncommitted work in foreman",
  status: "in_progress",
  project: "foreman",
  type: "task",
  priority: 2,
  labels: ["onboard"],
  description: null,
  last_activity_at: new Date(),
  created_at: new Date(),
};

const ready = {
  id: "ts-123456",
  title: "Test task",
  priority: 3,
  project: "foreman",
  labels: [],
  description: null,
  created_at: new Date(),
} as const;

describe("Prompts", () => {
  test("takes the operator's checkout away from the author", async () => {
    const prompt = await run((prompts) =>
      prompts.author(ready, "/tmp/worktree", "/tmp/repository"),
    );

    // Trivial work skips the reviewer, never the landing gate. An author told
    // to merge for itself is the one route past the verification foreman runs.
    expect(prompt).toContain("prog review ts-123456");
    expect(prompt).not.toContain("git -C /tmp/repository merge");
    expect(prompt).not.toContain("prog done ts-123456");
    expect(prompt).toContain("git worktree list --porcelain");
    expect(prompt).toContain("Never\nenter /tmp/repository to inspect it");
    expect(prompt).toContain("do not read another task's worktree");
  });

  // A pre-existing failure is filed once per author that hits it, reworded each
  // time, and each duplicate costs the fleet a full suite run. The whole dedup
  // is this block: the search command renders the project, and the instruction
  // is to append to an existing task rather than file a new one.
  test("an author searches the backlog before filing a pre-existing failure", async () => {
    const prompt = await run((prompts) =>
      prompts.author(ready, "/tmp/worktree", "/tmp/repository"),
    );

    expect(prompt).toContain("prog list -p foreman");
    expect(prompt).toContain("match on the test name, not on");
    expect(prompt).toContain("do not file a new one");
    expect(prompt).toContain('prog log <id> "<what failed>"');
    expect(prompt).toContain("only when nothing in the backlog describes it");
  });

  test("asks a successful reviewer for a verdict, not a merge", async () => {
    const prompt = await run((prompts) =>
      prompts.review(item, "/tmp/worktree", "/tmp/repository", "abc1234", "bun test"),
    );

    expect(prompt).toContain("prog label ts-123456 approved");
    expect(prompt).not.toContain("git -C /tmp/repository merge");
    expect(prompt).not.toContain("prog done ts-123456");
    expect(prompt).toContain("Never approve work that landing would omit");
  });

  // A reviewer's git process in the operator's checkout is what took the index
  // lock out from under a landing, so the whole prompt is asserted to run git
  // nowhere but the worktree — not merely to avoid merging there. The fork
  // point is what makes that possible: without it the author's work cannot be
  // named from inside the worktree at all.
  test("keeps every reviewer command out of the operator's checkout", async () => {
    const prompt = await run((prompts) =>
      prompts.review(item, "/tmp/worktree", "/tmp/repository", "abc1234", "bun test"),
    );

    expect(prompt).toContain("git -C /tmp/worktree diff abc1234 HEAD");
    expect(prompt).not.toContain("git -C /tmp/repository");
    expect(prompt).toContain("Never run git in /tmp/repository");
    expect(prompt).toContain("Do not read another task's worktree");
  });

  // Both wordings are asserted because the sentence is the whole of what stops
  // three agents running one machine's test suite at once, and the branch that
  // is never rendered in the operator's own config is the one that would rot.
  test("names the landing verification the reviewer must not repeat", async () => {
    const prompt = await run((prompts) =>
      prompts.review(item, "/tmp/worktree", "/tmp/repository", "abc1234", "bun test"),
    );

    expect(prompt).toContain("Foreman runs `bun test` in /tmp/repository");
    expect(prompt).toContain("do not spend a full suite run repeating it");
  });

  test("leaves the full run to a reviewer whose project has no verification", async () => {
    const prompt = await run((prompts) =>
      prompts.review(item, "/tmp/worktree", "/tmp/repository", "abc1234", undefined),
    );

    expect(prompt).toContain("lands this branch on git's exit code alone");
    expect(prompt).toContain("The full run is yours");
    expect(prompt).not.toContain("do not spend a full suite run repeating it");
  });

  test("diagnoses stuck work without taking over its implementation", async () => {
    const prompt = await run((prompts) =>
      prompts.diagnose(item, "/tmp/worktree", "/tmp/repository", "diagnose"),
    );

    expect(prompt).toContain("Diagnose why this attempt appears stuck");
    expect(prompt).toContain("prog log ts-123456");
    expect(prompt).toContain("Do not take over the implementation");
    expect(prompt).not.toContain("prog open ts-123456");
  });

  test("diagnostic review includes uncommitted edits", async () => {
    const prompt = await run((prompts) =>
      prompts.diagnose(item, "/tmp/worktree", "/tmp/repository", "review"),
    );

    expect(prompt).toContain("Review the work as it exists, including uncommitted edits");
  });

  test("sends an onboarding agent to the checkout and back off it", async () => {
    const prompt = await run((prompts) => prompts.onboard(item, "/tmp/repository"));

    expect(prompt).toContain("git -C /tmp/repository checkout -b foreman/ts-123456");
    // The whole safety of the run rests on the operator's branch ending where
    // they left it, so the instruction to return to it is asserted, not assumed.
    expect(prompt).toContain("git -C /tmp/repository checkout -\n");
  });
});
