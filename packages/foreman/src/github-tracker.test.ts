import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import type { GhResult } from "./github.ts";
import { fakeGh } from "./github-fixture.ts";
import { githubTracker, splitBody, type IssueNode } from "./github-tracker.ts";
import { TrackerError } from "./tracker.ts";

const node = (number: number, change: Partial<IssueNode> = {}): IssueNode => ({
  number,
  title: `issue ${number}`,
  body: `Body of ${number}.\n\n## Definition of done\nIt works.`,
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
  labels: { nodes: [] },
  assignees: { nodes: [] },
  parent: null,
  subIssuesSummary: { total: 0 },
  issueType: null,
  blockedBy: { nodes: [] },
  comments: { nodes: [] },
  ...change,
});

const ok = (stdout: string): GhResult => ({ exitCode: 0, stdout, stderr: "" });

const snapshot = (nodes: ReadonlyArray<IssueNode>) =>
  ok(
    JSON.stringify({
      data: {
        repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
        rateLimit: { remaining: 4000, limit: 5000, resetAt: "2026-11-03T00:00:00Z" },
      },
    }),
  );

const rest = (body: unknown) => ok(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}`);

/**
 * A GitHub with issues 1 to 3 in repo `o/r` of project `beta`. Issue 3 is
 * blocked by issue 2. The REST read of issue 1 shows the claim only after
 * `lag` reads following the write.
 */
const github = (options: { readonly lag?: number; readonly failRead?: boolean } = {}) => {
  let written = false;
  let readsAfterWrite = 0;
  const gh = fakeGh((args) => {
    if (args[1] === "graphql") {
      return options.failRead
        ? { exitCode: 1, stdout: "", stderr: "error connecting to api.github.com" }
        : snapshot([
            node(1),
            node(2, { labels: { nodes: [{ name: "status:in_progress" }, { name: "size:2" }] } }),
            node(3, {
              blockedBy: {
                nodes: [{ number: 2, state: "OPEN", repository: { nameWithOwner: "o/r" } }],
              },
            }),
          ]);
    }
    if (args.includes("user")) return rest({ login: "me" });
    if (args.includes("repos/o/r/issues/1")) {
      if (written) readsAfterWrite += 1;
      const shows = written && readsAfterWrite > (options.lag ?? 0);
      return rest({
        state: "open",
        labels: shows ? [{ name: "status:in_progress" }] : [],
        assignees: shows ? [{ login: "me" }] : [],
      });
    }
    if (args[0] === "issue" && args[1] === "edit") written = true;
    return ok("");
  });
  const tracker = githubTracker(() => Effect.succeed("o/r")).pipe(Effect.provide(gh.layer));
  return { calls: gh.calls, tracker };
};

const graphqlCalls = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter((args) => args[1] === "graphql").length;

describe("githubTracker reads", () => {
  test("ready answers the open, unassigned, unblocked tasks of one read", async () => {
    const { calls, tracker } = github();
    const { ready, item } = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* tracker;
        yield* t.refresh("beta");
        const ready = yield* t.ready("beta");
        const item = yield* t.lookup("beta#2");
        return { ready, item };
      }),
    );
    expect(ready.map((each) => each.id)).toEqual(["beta#1"]);
    expect(Option.map(item, (each) => [each.status, each.labels])).toEqual(
      Option.some(["in_progress", ["size:2"]]),
    );
    expect(graphqlCalls(calls)).toBe(1);
  });

  test("an issue's page comes from the project's read", async () => {
    const { calls, tracker } = github();
    const url = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* tracker;
        yield* t.refresh("beta");
        return yield* t.url("beta#2");
      }),
    );
    expect(url).toEqual(Option.some("https://github.com/o/r/issues/2"));
    expect(graphqlCalls(calls)).toBe(1);
  });

  test("a failed read fails every read until the next refresh", async () => {
    const { calls, tracker } = github({ failRead: true });
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* tracker;
        const refreshed = yield* Effect.exit(t.refresh("beta"));
        const ready = yield* Effect.exit(t.ready("beta"));
        return [refreshed._tag, ready._tag];
      }),
    );
    expect(exits).toEqual(["Failure", "Failure"]);
    expect(graphqlCalls(calls)).toBe(1);
  });
});

describe("githubTracker.claim", () => {
  test("re-reads until the claim shows", async () => {
    const { calls, tracker } = github({ lag: 2 });
    await Effect.gen(function* () {
      const t = yield* tracker;
      const fiber = yield* Effect.forkChild(t.claim("beta#1"));
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
    const edit = calls.find((args) => args[0] === "issue" && args[1] === "edit");
    expect(edit).toEqual([
      "issue",
      "edit",
      "1",
      "-R",
      "o/r",
      "--add-label",
      "status:in_progress",
      "--add-assignee",
      "@me",
    ]);
    // One read before the write, then three until the claim shows.
    expect(calls.filter((args) => args.includes("repos/o/r/issues/1"))).toHaveLength(4);
  });

  test("fails after 30 seconds when the claim never shows", async () => {
    const { tracker } = github({ lag: Number.POSITIVE_INFINITY });
    const error = await Effect.gen(function* () {
      const t = yield* tracker;
      const fiber = yield* Effect.forkChild(Effect.flip(t.claim("beta#1")));
      yield* TestClock.adjust(Duration.seconds(31));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
    expect(error).toBeInstanceOf(TrackerError);
    expect(error.detail).toContain("30 seconds");
  });
});

describe("splitBody", () => {
  test("takes the definition of done out of the description", () => {
    expect(splitBody("Intro.\n\n## Definition of done\nTests pass.\n\n## Notes\nMore.")).toEqual({
      description: "Intro.\n\n## Notes\nMore.",
      definitionOfDone: "Tests pass.",
    });
  });
});
