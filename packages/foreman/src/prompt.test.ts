import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Prompts } from "./prompt.ts";
import type { Item } from "./prog.ts";
import { authorRun } from "./task-fixture.ts";

// Prompts are prose wrapped at about 85 columns; the tests check what a rule says,
// not where a line happens to break, so whitespace runs read as one space.
const run = (f: (prompts: Prompts["Service"]) => Effect.Effect<string, unknown>) =>
  Effect.runPromise(Prompts.use(f).pipe(Effect.provide(Prompts.Default))).then((prompt) =>
    prompt.replace(/\s+/g, " "),
  );

const item: Item = {
  id: "ts-123456",
  title: "Adopt uncommitted work in foreman",
  status: "in_progress",
  project: "foreman",
  type: "task",
  priority: 2,
  labels: ["onboard"],
  description: "",
  parent: undefined,
  lastActivityAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(0),
  definitionOfDone: undefined,
  runs: [],
  tip: undefined,
};

const ready = {
  id: "ts-123456",
  title: "Test task",
  priority: 3,
  project: "foreman",
  labels: [],
  description: "",
  parent: undefined,
  createdAt: new Date(),
  updatedAt: new Date(0),
  lastActivityAt: new Date(0),
  definitionOfDone: undefined,
  type: "task",
  status: "open",
  runs: [],
  tip: undefined,
} as const;

describe("Prompts", () => {
  test("takes the operator's checkout away from the author", async () => {
    const prompt = await run((prompts) =>
      prompts.author(ready, "/tmp/worktree", "/tmp/repository", "worktree"),
    );

    // Trivial work skips the reviewer, never the landing gate. An author told
    // to merge for itself is the one route past the verification foreman runs.
    expect(prompt).toContain("tasks review ts-123456");
    expect(prompt).not.toContain("git -C /tmp/repository merge");
    expect(prompt).not.toContain("tasks done ts-123456");
    expect(prompt).toContain("git worktree list --porcelain");
    expect(prompt).toContain("Never enter /tmp/repository");
    expect(prompt).toContain("do not read another task's worktree");
  });

  test("an author and reviewer in the operator's checkout are told it is theirs, not forbidden", async () => {
    const author = await run((prompts) =>
      prompts.author(ready, "/tmp/repository", "/tmp/repository", "branch"),
    );
    expect(author).toContain("This is the operator's own checkout");
    expect(author).toContain("git diff @{upstream}...HEAD");
    expect(author).not.toContain("Never enter /tmp/repository");

    const review = await run((prompts) =>
      prompts.review(item, "/tmp/repository", "/tmp/repository", "branch", "abc123", undefined),
    );
    expect(review).toContain("the operator's own checkout, which has the task's branch out");
    expect(review).not.toContain("Never run git in /tmp/repository");
  });

  test("an author and reviewer on the operator's own branch read the work from its base and undo nothing", async () => {
    const author = await run((prompts) =>
      prompts.author(ready, "/tmp/repository", "/tmp/repository", "none", "abc123"),
    );
    expect(author).toContain("git log abc123..HEAD");
    expect(author).toContain("git diff abc123 HEAD");
    expect(author).toContain("not by undoing old ones");
    expect(author).not.toContain("Foreman merges");
    expect(author).not.toContain("foreman/ts-123456");

    const review = await run((prompts) =>
      prompts.review(item, "/tmp/repository", "/tmp/repository", "none", "abc123", "bun test"),
    );
    expect(review).toContain("git -C /tmp/repository diff abc123 HEAD");
    expect(review).toContain("never an undo");
    expect(review).toContain("the full run is yours");
    expect(review).not.toContain("foreman/ts-123456");
  });

  // A pre-existing failure is filed once per author that hits it, reworded each
  // time, and each duplicate costs the fleet a full suite run. The whole dedup
  // is this block: the search command renders the project, and the instruction
  // is to append to an existing task rather than file a new one.
  test("an author searches the backlog before filing a pre-existing failure", async () => {
    const prompt = await run((prompts) =>
      prompts.author(ready, "/tmp/worktree", "/tmp/repository", "worktree"),
    );

    expect(prompt).toContain("tasks list -p foreman");
    expect(prompt).toContain("match on the test name, not on");
    expect(prompt).toContain("do not file a new one");
    expect(prompt).toContain('tasks log <id> "<what failed>"');
    expect(prompt).toContain("only when nothing in the backlog describes it");
  });

  test("asks a successful reviewer for a verdict, not a merge", async () => {
    const prompt = await run((prompts) =>
      prompts.review(item, "/tmp/worktree", "/tmp/repository", "worktree", "abc1234", "bun test"),
    );

    expect(prompt).toContain("tasks verdict ts-123456 approved");
    expect(prompt).toContain("tasks verdict ts-123456 returned");
    expect(prompt).not.toContain("tasks label");
    expect(prompt).not.toContain("git -C /tmp/repository merge");
    expect(prompt).not.toContain("tasks done ts-123456");
    expect(prompt).toContain("Never approve work that landing would omit");
  });

  // A reviewer's git process in the operator's checkout is what took the index
  // lock out from under a landing, so the whole prompt is asserted to run git
  // nowhere but the worktree — not merely to avoid merging there. The fork
  // point is what makes that possible: without it the author's work cannot be
  // named from inside the worktree at all.
  test("keeps every reviewer command out of the operator's checkout", async () => {
    const prompt = await run((prompts) =>
      prompts.review(item, "/tmp/worktree", "/tmp/repository", "worktree", "abc1234", "bun test"),
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
      prompts.review(item, "/tmp/worktree", "/tmp/repository", "worktree", "abc1234", "bun test"),
    );

    expect(prompt).toContain("Foreman runs `bun test` in /tmp/repository");
    expect(prompt).toContain("do not spend a full suite run repeating it");
  });

  test("leaves the full run to a reviewer whose project has no verification", async () => {
    const prompt = await run((prompts) =>
      prompts.review(item, "/tmp/worktree", "/tmp/repository", "worktree", "abc1234", undefined),
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
    expect(prompt).toContain("tasks log ts-123456");
    expect(prompt).toContain("Do not take over the implementation");
    expect(prompt).not.toContain("tasks open ts-123456");
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
    expect(prompt).toContain("git -C /tmp/repository checkout - ");
  });

  // A rare case reaches only the agents whose task carries its label, so every
  // other prompt stays short; the rule itself must still arrive where it applies.
  test("gives the research and satisfied rules only to tasks that call for them", async () => {
    const plainAuthor = await run((prompts) =>
      prompts.author(ready, "/tmp/worktree", "/tmp/repository", "worktree"),
    );
    const researchAuthor = await run((prompts) =>
      prompts.author(
        { ...ready, labels: ["research"] },
        "/tmp/worktree",
        "/tmp/repository",
        "worktree",
      ),
    );
    expect(plainAuthor).not.toContain("labelled `research`");
    expect(researchAuthor).toContain("labelled `research`: the deliverable is a report");

    const review = (labels: ReadonlyArray<string>, satisfied = false) =>
      run((prompts) =>
        prompts.review(
          {
            ...item,
            labels: [...labels],
            runs: satisfied ? [authorRun("cheap", { open: false, ending: "satisfied" })] : [],
          },
          "/tmp/worktree",
          "/tmp/repository",
          "worktree",
          "abc1234",
          "bun test",
        ),
      );
    const plain = await review([]);
    expect(plain).not.toContain("ended its run `satisfied`");
    expect(plain).not.toContain("labelled `research`");
    expect(await review([], true)).toContain("ended its run `satisfied`");
    expect(await review(["research"])).toContain(
      "labelled `research`: the deliverable is the report",
    );
  });
});
