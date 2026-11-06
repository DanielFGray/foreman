import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Schema as S } from "effect";
import { Policy, schedulesOf } from "./policy.ts";
import {
  type AgentNode,
  instructionProblems,
  instructionsOf,
  STANDARD_PIPELINES,
  type Workspace,
} from "./pipeline.ts";
import { renameExit } from "./pipeline-belt.ts";
import { Prompts } from "./prompt.ts";
import type { Item } from "./records.ts";
import { authorRun } from "./task-fixture.ts";

// Prompts are prose wrapped at about 85 columns; the tests check what a rule says,
// not where a line happens to break, so whitespace runs read as one space.
const run = (f: (prompts: Prompts["Service"]) => Effect.Effect<string, unknown>) =>
  Effect.runPromise(Prompts.use(f).pipe(Effect.provide(Prompts.Default))).then((prompt) =>
    prompt.replace(/\s+/g, " "),
  );

const blockOf = (role: AgentNode["role"], pipeline = STANDARD_PIPELINES.worktree): AgentNode => {
  const block = pipeline.nodes.find(
    (node): node is AgentNode => node.kind === "agent" && node.role === role,
  );
  if (block === undefined) throw new Error(`the pipeline has no ${role}`);
  return block;
};

const authorPrompt = (
  prompts: Prompts["Service"],
  task: Item,
  worktree: string,
  repository: string,
  workspace: Workspace,
  base = "abc1234",
) =>
  prompts.agent(blockOf("author"), {
    task,
    worktree,
    repository,
    workspace,
    base,
    trunk: "develop",
    pipeline: STANDARD_PIPELINES.worktree,
  });

const reviewPrompt = (
  prompts: Prompts["Service"],
  task: Item,
  worktree: string,
  repository: string,
  workspace: Workspace,
  base: string,
  verify: string | undefined,
) =>
  prompts.agent(blockOf("review"), {
    task,
    worktree,
    repository,
    workspace,
    base,
    trunk: "develop",
    verify,
    pipeline: STANDARD_PIPELINES.worktree,
  });
const item: Item = {
  id: "ts-123456",
  title: "Adopt uncommitted work in foreman",
  status: "in_progress",
  project: "foreman",
  type: "task",
  priority: 2,
  labels: ["onboard"],
  description: "",
  parent: Option.none(),
  lastActivityAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(0),
  definitionOfDone: Option.none(),
  runs: [],
  charges: [],
  parked: undefined,
  tip: undefined,
};

const ready = {
  id: "ts-123456",
  title: "Test task",
  priority: 3,
  project: "foreman",
  labels: [],
  description: "",
  parent: Option.none(),
  createdAt: new Date(),
  updatedAt: new Date(0),
  lastActivityAt: new Date(0),
  definitionOfDone: Option.none(),
  type: "task",
  status: "open",
  runs: [],
  charges: [],
  parked: undefined,
  tip: undefined,
} as const;

describe("Prompts", () => {
  test("takes the operator's checkout away from the author", async () => {
    const prompt = await run((prompts) =>
      authorPrompt(prompts, ready, "/tmp/worktree", "/tmp/repository", "worktree"),
    );

    // Trivial work skips the reviewer, never the landing gate. An author told
    // to merge for itself is the one route past the verification foreman runs.
    expect(prompt).toContain("foreman exit ts-123456 done");
    expect(prompt).not.toContain("git -C /tmp/repository merge");
    expect(prompt).not.toContain("tasks done ts-123456");
    expect(prompt).toContain("git diff develop...HEAD");
    expect(prompt).toContain("Never enter /tmp/repository");
    expect(prompt).toContain("do not read another task's worktree");
  });

  test("an author and reviewer in the operator's checkout are told it is theirs, not forbidden", async () => {
    const author = await run((prompts) =>
      authorPrompt(prompts, ready, "/tmp/repository", "/tmp/repository", "branch"),
    );
    expect(author).toContain("This is the operator's own checkout");
    expect(author).toContain("git diff develop...HEAD");
    expect(author).not.toContain("Never enter /tmp/repository");

    const review = await run((prompts) =>
      reviewPrompt(
        prompts,
        item,
        "/tmp/repository",
        "/tmp/repository",
        "branch",
        "abc123",
        undefined,
      ),
    );
    expect(review).toContain("the operator's own checkout, which has the task's branch out");
    expect(review).not.toContain("Never run git in /tmp/repository");
  });

  test("an author and reviewer on the operator's own branch read the work from its base and undo nothing", async () => {
    const author = await run((prompts) =>
      authorPrompt(prompts, ready, "/tmp/repository", "/tmp/repository", "none", "abc123"),
    );
    expect(author).toContain("git log abc123..HEAD");
    expect(author).toContain("git diff abc123 HEAD");
    expect(author).toContain("not by undoing old ones");
    expect(author).not.toContain("Foreman merges");
    expect(author).not.toContain("foreman/ts-123456");

    const review = await run((prompts) =>
      reviewPrompt(
        prompts,
        item,
        "/tmp/repository",
        "/tmp/repository",
        "none",
        "abc123",
        "bun test",
      ),
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
      authorPrompt(prompts, ready, "/tmp/worktree", "/tmp/repository", "worktree"),
    );

    expect(prompt).toContain("foreman list -p foreman");
    expect(prompt).toContain("foreman show ts-123456");
    expect(prompt).not.toMatch(/tasks (show|log)/);
    expect(prompt).toContain("match on the test name, not on");
    expect(prompt).toContain("do not file a new one");
    expect(prompt).toContain('foreman log <id> "<what failed>"');
    expect(prompt).toContain("only when nothing in the backlog describes it");
  });

  test("asks a successful reviewer for an exit, not a merge", async () => {
    const prompt = await run((prompts) =>
      reviewPrompt(
        prompts,
        item,
        "/tmp/worktree",
        "/tmp/repository",
        "worktree",
        "abc1234",
        "bun test",
      ),
    );

    expect(prompt).toContain("foreman exit ts-123456 approved");
    expect(prompt).toContain("foreman exit ts-123456 returned");
    expect(prompt).not.toContain("tasks label");
    expect(prompt).not.toContain("git -C /tmp/repository merge");
    expect(prompt).not.toContain("tasks done ts-123456");
    expect(prompt).toContain("Never approve work that landing would omit");
  });

  // A git process in the operator's checkout collides with a landing that
  // holds the index lock, so the whole prompt is asserted to run git nowhere
  // but the worktree, not merely to avoid merging there. The fork point is
  // what makes that possible: without it the author's work cannot be named
  // from inside the worktree at all.
  test("keeps every reviewer command out of the operator's checkout", async () => {
    const prompt = await run((prompts) =>
      reviewPrompt(
        prompts,
        item,
        "/tmp/worktree",
        "/tmp/repository",
        "worktree",
        "abc1234",
        "bun test",
      ),
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
      reviewPrompt(
        prompts,
        item,
        "/tmp/worktree",
        "/tmp/repository",
        "worktree",
        "abc1234",
        "bun test",
      ),
    );

    expect(prompt).toContain("Foreman runs `bun test` in /tmp/repository");
    expect(prompt).toContain("do not spend a full suite run repeating it");
  });

  test("leaves the full run to a reviewer whose project has no verification", async () => {
    const prompt = await run((prompts) =>
      reviewPrompt(
        prompts,
        item,
        "/tmp/worktree",
        "/tmp/repository",
        "worktree",
        "abc1234",
        undefined,
      ),
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
    expect(prompt).toContain("foreman log ts-123456 -");
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
  test("gives the research and already-done rules only to tasks that call for them", async () => {
    const plainAuthor = await run((prompts) =>
      authorPrompt(prompts, ready, "/tmp/worktree", "/tmp/repository", "worktree"),
    );
    const researchAuthor = await run((prompts) =>
      authorPrompt(
        prompts,
        { ...ready, labels: ["research"] },
        "/tmp/worktree",
        "/tmp/repository",
        "worktree",
      ),
    );
    expect(plainAuthor).not.toContain("labelled `research`");
    expect(researchAuthor).toContain("labelled `research`: the deliverable is a report");

    const review = (labels: ReadonlyArray<string>, alreadyDone = false) =>
      run((prompts) =>
        reviewPrompt(
          prompts,
          {
            ...item,
            labels: [...labels],
            runs: alreadyDone ? [authorRun("cheap", { open: false, ending: "already-done" })] : [],
          },
          "/tmp/worktree",
          "/tmp/repository",
          "worktree",
          "abc1234",
          "bun test",
        ),
      );
    const plain = await review([]);
    expect(plain).not.toContain("ended its run `already-done`");
    expect(plain).not.toContain("labelled `research`");
    expect(await review([], true)).toContain("ended its run `already-done`");
    expect(await review(["research"])).toContain(
      "labelled `research`: the deliverable is the report",
    );
  });

  test("a prompt is the task, the workspace, the instructions and the exits, in that order", async () => {
    const prompt = await run((prompts) =>
      authorPrompt(prompts, ready, "/tmp/worktree", "/tmp/repository", "worktree"),
    );
    const order = ["## Task", "## Workspace", "## Start", "## Exits"].map((heading) =>
      prompt.indexOf(heading),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt).toContain(
      "`foreman exit ts-123456 already-done`: the task goes to review-gate.",
    );
    expect(prompt).toContain("If you name none, the task retries.");
  });

  // The operator draws the contract: a new exit, a park on a stop and their
  // own instructions file all reach the agent with no change to foreman.
  test("an operator's drawing and instructions file make the prompt", async () => {
    const config = mkdtempSync(join(tmpdir(), "foreman-prompts-"));
    mkdirSync(join(config, "foreman", "prompts"), { recursive: true });
    writeFileSync(
      join(config, "foreman", "prompts", "careful.md"),
      "Read {{ task }} twice in {{ worktree }}.",
    );
    const block: AgentNode = {
      kind: "agent",
      id: "careful",
      role: "review",
      model: "reviewers",
      instructions: "careful",
      stopped: "park",
      exits: [
        { id: "approved", name: "approved", to: "land-gate" },
        { id: "needs-tests", name: "needs-tests", to: "queue", fails: "author" },
      ],
    };
    const previous = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = config;
    try {
      const prompt = await run((prompts) =>
        prompts.agent(block, {
          task: item,
          worktree: "/tmp/worktree",
          repository: "/tmp/repository",
          workspace: "worktree",
          base: "abc1234",
          trunk: "develop",
          pipeline: undefined,
        }),
      );
      expect(prompt).toContain("Read ts-123456 twice in /tmp/worktree.");
      expect(prompt).toContain(
        "`foreman exit ts-123456 needs-tests`: the task returns to the queue, and the author's model is charged with a failure.",
      );
      expect(prompt).not.toContain("returned");
      expect(prompt).toContain("If you name none, the task parks.");
    } finally {
      if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previous;
    }
  });

  test("an unknown placeholder is a problem in the drawing and refuses the render", async () => {
    const block: AgentNode = { ...blockOf("author"), instructions: "typo" };
    const pipeline = { nodes: [block] };
    expect(instructionProblems(pipeline, new Map([["typo", "Read {{ title }}."]]))).toEqual([
      "author: typo.md uses {{ title }}, which is no placeholder: use task, branch, base, worktree",
    ]);
    expect(instructionProblems(pipeline, new Map())).toEqual([
      "author: no readable instructions file is named typo.md",
    ]);
    expect(
      instructionProblems(
        STANDARD_PIPELINES.worktree,
        new Map([
          ["author", "{{ base }}"],
          ["review", ""],
        ]),
      ),
    ).toEqual([]);

    const config = mkdtempSync(join(tmpdir(), "foreman-prompts-"));
    mkdirSync(join(config, "foreman", "prompts"), { recursive: true });
    writeFileSync(join(config, "foreman", "prompts", "typo.md"), "Read {{ title }}.");
    const previous = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = config;
    try {
      const failure = await Effect.runPromise(
        Prompts.use((prompts) =>
          prompts.agent(block, {
            task: ready,
            worktree: "/tmp/worktree",
            repository: "/tmp/repository",
            workspace: "worktree",
            base: "abc1234",
            trunk: "develop",
            pipeline: undefined,
          }),
        ).pipe(Effect.flip, Effect.provide(Prompts.Default)),
      );
      expect(failure.message).toContain("{{ title }} is no placeholder");
    } finally {
      if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previous;
    }
  });

  test("an operator's file wins over the instructions foreman ships", async () => {
    const config = mkdtempSync(join(tmpdir(), "foreman-prompts-"));
    mkdirSync(join(config, "foreman", "prompts"), { recursive: true });
    writeFileSync(join(config, "foreman", "prompts", "author.md"), "Operator text for {{ task }}.");
    const previous = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = config;
    try {
      const prompt = await run((prompts) =>
        authorPrompt(prompts, ready, "/tmp/worktree", "/tmp/repository", "worktree"),
      );
      expect(prompt).toContain("Operator text for ts-123456.");
      expect(prompt).not.toContain("You are working alone on one task");
      expect(prompt).toContain("`foreman exit ts-123456 done`");
    } finally {
      if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previous;
    }
  });
});

// A drawing may rename or remove any exit, so the instructions foreman ships
// for agent blocks name none: only the generated Exits section does, from the
// block itself.
describe("the instructions foreman ships for agent blocks", () => {
  const exitNames = new Set(
    Object.values(STANDARD_PIPELINES).flatMap((pipeline) =>
      pipeline.nodes.flatMap((node) =>
        node.kind === "agent" || node.kind === "check" ? node.exits.map((exit) => exit.name) : [],
      ),
    ),
  );

  const shipped = new Set(
    Object.values(STANDARD_PIPELINES).flatMap((pipeline) =>
      pipeline.nodes.flatMap((node) => (node.kind === "agent" ? [instructionsOf(node)] : [])),
    ),
  );

  for (const name of shipped) {
    test(`${name}.md names no exit`, () => {
      const text = readFileSync(join(import.meta.dir, "..", "prompts", `${name}.md`), "utf8");
      expect(text).not.toContain("foreman exit");
      for (const exit of exitNames) expect(text).not.toContain(`\`${exit}\``);
    });
  }

  test("the claim guidance follows the declared claim, under the name it is drawn with", async () => {
    const pipeline = renameExit(
      STANDARD_PIPELINES.worktree,
      "author",
      "already-done",
      "nothing-to-do",
    );
    const author = blockOf("author", pipeline);
    const prompt = (block: AgentNode) =>
      run((prompts) =>
        prompts.agent(block, {
          task: ready,
          worktree: "/tmp/worktree",
          repository: "/tmp/repository",
          workspace: "worktree",
          base: "abc1234",
          trunk: "develop",
          pipeline,
        }),
      );
    const renamed = await prompt(author);
    expect(renamed).toContain("`foreman exit ts-123456 nothing-to-do`");
    expect(renamed).toContain(
      "Name `nothing-to-do` only when trunk already does everything the task asks",
    );
    expect(renamed).not.toContain("already-done");
    // A name alone means nothing: an exit called already-done that declares
    // no claim gets no guidance.
    const unmarked = await prompt({
      ...blockOf("author"),
      exits: blockOf("author").exits.map(({ empty: _empty, ...exit }) => exit),
    });
    expect(unmarked).not.toContain("only when trunk already does everything");

    // The reviewer reads the claim the author made, under its name as drawn now.
    const review = await run((prompts) =>
      prompts.agent(blockOf("review"), {
        task: { ...item, runs: [authorRun("cheap", { open: false, ending: "already-done" })] },
        worktree: "/tmp/worktree",
        repository: "/tmp/repository",
        workspace: "worktree",
        base: "abc1234",
        trunk: "develop",
        pipeline,
      }),
    );
    expect(review).toContain(
      "ended its run `nothing-to-do`: it claims trunk (`develop`) already does",
    );
  });
});

describe("a schedule's template read through the real reader", () => {
  const withConfigDirectory = async <A>(files: Record<string, string>, f: () => Promise<A>) => {
    const root = mkdtempSync(join(tmpdir(), "foreman-config-"));
    mkdirSync(join(root, "foreman", "prompts"), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(root, "foreman", "prompts", `${name}.md`), text);
    }
    const before = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = root;
    try {
      return await f();
    } finally {
      if (before === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = before;
    }
  };

  // The template a policy file names, as the dispatcher reads it from the policy.
  const templateOf = (template: string) => {
    const policy = S.decodeSync(Policy)({
      projects: {
        alpha: { schedules: [{ name: "retro", every: { landed: 5 }, title: "t", template }] },
      },
    });
    const [schedule] = schedulesOf(policy, "alpha");
    if (schedule === undefined) throw new Error("the policy has no schedule");
    return schedule.template;
  };

  const render = (template: string) =>
    Effect.runPromise(
      Prompts.use((prompts) =>
        prompts.template(template, { project: "alpha", since: "2026-01-01T00:00:00.000Z" }),
      ).pipe(Effect.provide(Prompts.Default)),
    );

  test("the operator's copy named by a policy entry's .md wins over the shipped file", async () => {
    const text = await withConfigDirectory(
      { retro: "Operator retro: {{ project }} since {{ since }}." },
      () => render(templateOf("retro.md")),
    );
    expect(text).toBe("Operator retro: alpha since 2026-01-01T00:00:00.000Z.");
  });

  test("the shipped retro template renders with the values a schedule gives it", async () => {
    const text = await withConfigDirectory({}, () => render(templateOf("retro.md")));
    expect(text).not.toContain("{{");
    expect(text).toContain("foreman runs -p alpha --since 2026-01-01T00:00:00.000Z");
  });
});
