import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { Linear, LinearError, type LinearRate } from "./linear.ts";
import { checkPlace, linearTracker, type IssueNode, type WorkflowState } from "./linear-tracker.ts";
import { TrackerError } from "./tracker.ts";

const STATES: ReadonlyArray<WorkflowState> = [
  { id: "s-triage", name: "Triage", type: "triage" },
  { id: "s-backlog", name: "Backlog", type: "backlog" },
  { id: "s-ready", name: "Ready", type: "unstarted" },
  { id: "s-todo", name: "Todo", type: "unstarted" },
  { id: "s-review", name: "In Review", type: "started" },
  { id: "s-progress", name: "In Progress", type: "started" },
  { id: "s-done", name: "Done", type: "completed" },
  { id: "s-canceled", name: "Canceled", type: "canceled" },
];

const node = (number: number, change: Partial<IssueNode> = {}): IssueNode => ({
  id: `uuid-${number}`,
  identifier: `ENG-${number}`,
  url: `https://linear.app/acme/issue/ENG-${number}`,
  title: `issue ${number}`,
  description: `Body of ${number}.\n\n## Definition of done\nIt works.`,
  priority: 3,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
  state: { type: "unstarted" },
  assignee: null,
  project: { id: "p-1" },
  parent: null,
  children: { nodes: [] },
  labels: { nodes: [] },
  inverseRelations: { nodes: [] },
  comments: { nodes: [] },
  ...change,
});

interface Call {
  readonly document: string;
  readonly variables: Record<string, unknown>;
}

/**
 * A fake Linear GraphQL endpoint over `issues`, the open list of team `ENG`,
 * project `Foreman`, served 100 a page. `closed` holds issues outside that
 * list, found by number and by id. Mutations change the issue they name.
 */
const fakeLinear = (
  options: {
    readonly issues?: ReadonlyArray<IssueNode>;
    readonly closed?: ReadonlyArray<IssueNode>;
    readonly states?: ReadonlyArray<WorkflowState>;
    readonly rate?: LinearRate;
  } = {},
) => {
  const calls: Array<Call> = [];
  const issues = new Map((options.issues ?? []).map((issue) => [issue.identifier, issue]));
  const closed = new Map((options.closed ?? []).map((issue) => [issue.identifier, issue]));
  const find = (identifier: unknown) =>
    issues.get(String(identifier)) ?? closed.get(String(identifier));
  const page = (after: unknown) => {
    const all = [...issues.values()].filter(
      (issue) => issue.state.type !== "completed" && issue.state.type !== "canceled",
    );
    const start = after === undefined ? 0 : Number(after);
    const nodes = all.slice(start, start + 100);
    const end = start + nodes.length;
    return { pageInfo: { hasNextPage: end < all.length, endCursor: `${end}` }, nodes };
  };
  const answer = (document: string, variables: Record<string, unknown>): unknown => {
    if (document.includes("viewer {"))
      return {
        viewer: { id: "me" },
        teams: {
          nodes: [
            {
              id: "t-1",
              states: { nodes: options.states ?? STATES },
              labels: { nodes: [{ id: "l-size", name: "size:2" }] },
              projects: { nodes: [{ id: "p-1" }] },
            },
          ],
        },
        held: {
          nodes: [...issues.values(), ...closed.values()].filter((issue) =>
            (variables["held"] as ReadonlyArray<string>).includes(issue.id),
          ),
        },
        issues: page(undefined),
      };
    if (document.startsWith("\nquery($held"))
      return {
        held: {
          nodes: [...issues.values(), ...closed.values()].filter((issue) =>
            (variables["held"] as ReadonlyArray<string>).includes(issue.id),
          ),
        },
      };
    if (document.includes("labels: { some:")) {
      const matching = [...issues.values(), ...closed.values()].filter((issue) =>
        issue.labels.nodes.some((label) => label.name === variables["label"]),
      );
      return { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: matching } };
    }
    if (document.includes("after: $after")) return { issues: page(variables["after"]) };
    if (document.includes("number: { eq: $number }")) {
      const issue = find(`${String(variables["team"])}-${String(variables["number"])}`);
      return { issues: { nodes: issue === undefined ? [] : [issue] } };
    }
    if (document.includes("comments(first: 250)"))
      return {
        issue: {
          comments: {
            nodes: [
              { body: "second", createdAt: "2026-11-02T00:00:00Z", user: { name: "Ann" } },
              { body: "first", createdAt: "2026-11-01T00:00:00Z", user: null },
            ],
          },
        },
      };
    if (document.includes("issue(id: $id) {")) {
      const issue = find(variables["id"])!;
      return { issue: { state: issue.state, assignee: issue.assignee, labels: issue.labels } };
    }
    if (document.includes("issueUpdate")) {
      const issue = find(variables["id"])!;
      const input = variables["input"] as { stateId?: string; assigneeId?: string | null };
      const state = STATES.find((each) => each.id === input.stateId);
      const next: IssueNode = {
        ...issue,
        ...(state === undefined ? {} : { state: { type: state.type } }),
        ...("assigneeId" in input
          ? { assignee: input.assigneeId == null ? null : { id: input.assigneeId } }
          : {}),
      };
      issues.set(next.identifier, next);
      return { result: { success: true } };
    }
    if (document.includes("issueCreate"))
      return { result: { success: true, issue: { identifier: "ENG-500" } } };
    if (document.includes("issueLabelCreate"))
      return { result: { success: true, issueLabel: { id: "l-new" } } };
    if (document.includes("commentCreate")) return { result: { success: true } };
    if (document.includes("projects(first: 1, filter"))
      return {
        teams: {
          nodes: [
            { states: { nodes: options.states ?? STATES }, projects: { nodes: [{ id: "p-1" }] } },
          ],
        },
      };
    throw new Error(`fake Linear has no answer for ${document}`);
  };
  const layer = Layer.succeed(
    Linear,
    Linear.of({
      graphql: (document, variables) =>
        Effect.suspend(() => {
          calls.push({ document, variables });
          return Effect.try({
            try: () => ({ data: answer(document, variables), rate: options.rate }),
            catch: (error) => new LinearError({ detail: String(error) }),
          });
        }),
    }),
  );
  const tracker = linearTracker(() => Effect.succeed({ team: "ENG", project: "Foreman" })).pipe(
    Effect.provide(layer),
  );
  return { calls, issues, layer, tracker };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("linearTracker", () => {
  test("labeled reads include closed issues", async () => {
    const closed = node(9, {
      state: { type: "completed" },
      labels: { nodes: [{ name: "schedule:retro" }] },
    });
    const linear = fakeLinear({ closed: [closed] });
    const found = await run(
      Effect.gen(function* () {
        const t = yield* linear.tracker;
        return yield* t.labeled("foreman", "schedule:retro");
      }),
    );
    expect(found.map((issue) => [issue.id, issue.status])).toEqual([["foreman#ENG-9", "done"]]);
  });

  test("an issue's page is its Linear url", async () => {
    const linear = fakeLinear({ issues: [node(1)] });
    const result = await run(
      Effect.gen(function* () {
        const t = yield* linear.tracker;
        yield* t.refresh("foreman");
        return yield* t.url("foreman#ENG-1");
      }),
    );
    expect(result).toEqual(Option.some("https://linear.app/acme/issue/ENG-1"));
  });

  test("reads an issue as an Item, with status by state type and Linear priority mapped", async () => {
    const linear = fakeLinear({
      issues: [
        node(1, { priority: 1 }),
        node(2, { state: { type: "started" }, labels: { nodes: [{ name: "size:2" }] } }),
        node(3, {
          priority: 4,
          inverseRelations: {
            nodes: [
              {
                type: "blocks",
                issue: { identifier: "ENG-2", state: { type: "started" }, project: { id: "p-1" } },
              },
            ],
          },
        }),
        node(4, { assignee: { id: "someone" } }),
        node(5, { state: { type: "triage" }, children: { nodes: [{ id: "uuid-6" }] } }),
      ],
    });
    const result = await run(
      Effect.gen(function* () {
        const tracker = yield* linear.tracker;
        return {
          items: yield* tracker.list({ project: "foreman" }),
          ready: yield* tracker.ready("foreman"),
          edges: yield* tracker.dependencies("foreman"),
        };
      }),
    );
    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get("foreman#ENG-1")).toMatchObject({
      status: "open",
      priority: 1,
      description: "Body of 1.",
      definitionOfDone: Option.some("It works."),
    });
    expect(byId.get("foreman#ENG-2")).toMatchObject({ status: "in_progress", labels: ["size:2"] });
    expect(byId.get("foreman#ENG-3")).toMatchObject({ status: "blocked", priority: 3 });
    expect(byId.get("foreman#ENG-4")?.status).toBe("in_progress");
    expect(byId.get("foreman#ENG-5")).toMatchObject({ status: "proposed", type: "epic" });
    expect(result.ready.map((item) => item.id)).toEqual(["foreman#ENG-1"]);
    expect(result.edges).toEqual([{ item: "foreman#ENG-3", dependsOn: "foreman#ENG-2" }]);
  });

  test("pages past 250 issues and holds the snapshot until the next refresh", async () => {
    const linear = fakeLinear({
      issues: Array.from({ length: 260 }, (_, index) => node(index + 1)),
    });
    const count = await run(
      Effect.gen(function* () {
        const tracker = yield* linear.tracker;
        yield* tracker.refresh("foreman");
        const items = yield* tracker.list({ project: "foreman" });
        yield* tracker.ready("foreman");
        return items.length;
      }),
    );
    expect(count).toBe(260);
    expect(linear.calls.filter((call) => call.document.includes("issues(first: 100"))).toHaveLength(
      3,
    );
  });

  test("an issue closed on Linear while held reads closed after the next refresh", async () => {
    const linear = fakeLinear({
      issues: [node(1)],
      closed: [node(9, { state: { type: "completed" } })],
    });
    const status = await run(
      Effect.gen(function* () {
        const tracker = yield* linear.tracker;
        const found = yield* tracker.lookup("foreman#ENG-9");
        yield* tracker.refresh("foreman");
        const read = yield* tracker.list({ project: "foreman" });
        return {
          found: Option.map(found, (item) => item.status),
          listed: read.find((item) => item.id === "foreman#ENG-9")?.status,
          missing: yield* tracker.lookup("foreman#ENG-77"),
        };
      }),
    );
    expect(status.found).toEqual(Option.some("done"));
    expect(status.listed).toBe("done");
    expect(status.missing).toEqual(Option.none());
  });

  test("a team with no state of a type foreman moves to reads unreachable", async () => {
    const states = STATES.filter((state) => state.type !== "started");
    const linear = fakeLinear({ issues: [node(1)], states });
    const failure = await run(
      Effect.gen(function* () {
        const tracker = yield* linear.tracker;
        const refreshed = yield* Effect.flip(tracker.refresh("foreman"));
        const listed = yield* Effect.flip(tracker.list({ project: "foreman" }));
        const checked = yield* Effect.flip(
          checkPlace({ team: "ENG", project: "Foreman" }).pipe(Effect.provide(linear.layer)),
        );
        return { refreshed, listed, checked };
      }),
    );
    expect(failure.refreshed).toBeInstanceOf(TrackerError);
    expect(failure.refreshed.detail).toContain("no workflow state of type started");
    expect(failure.listed.detail).toBe(failure.refreshed.detail);
    expect(failure.checked.detail).toContain("no workflow state of type started");
    // The failed read is held: the list made no second query.
    expect(linear.calls).toHaveLength(2);
  });

  test("claim moves to the In Progress state with the viewer, and moves skip what is already true", async () => {
    const linear = fakeLinear({ issues: [node(1)] });
    await run(
      Effect.gen(function* () {
        const tracker = yield* linear.tracker;
        yield* tracker.claim("foreman#ENG-1");
        yield* tracker.claim("foreman#ENG-1");
        yield* tracker.complete("foreman#ENG-1");
        yield* tracker.complete("foreman#ENG-1");
      }),
    );
    const updates = linear.calls
      .filter((call) => call.document.includes("issueUpdate"))
      .map((call) => call.variables["input"]);
    expect(updates).toEqual([{ stateId: "s-progress", assigneeId: "me" }, { stateId: "s-done" }]);
  });

  test("cancel moves to the canceled state once", async () => {
    const linear = fakeLinear({ issues: [node(1)] });
    await run(
      Effect.gen(function* () {
        const tracker = yield* linear.tracker;
        yield* tracker.cancel("foreman#ENG-1");
        yield* tracker.cancel("foreman#ENG-1");
      }),
    );
    const updates = linear.calls
      .filter((call) => call.document.includes("issueUpdate"))
      .map((call) => call.variables["input"]);
    expect(updates).toEqual([{ stateId: "s-canceled" }]);
  });

  test("reopen moves to Todo with no assignee", async () => {
    const linear = fakeLinear({
      issues: [node(1, { state: { type: "started" }, assignee: { id: "me" } })],
    });
    await run(Effect.flatMap(linear.tracker, (tracker) => tracker.reopen("foreman#ENG-1")));
    expect(linear.issues.get("ENG-1")).toMatchObject({
      state: { type: "unstarted" },
      assignee: null,
    });
    const update = linear.calls.find((call) => call.document.includes("issueUpdate"));
    expect(update?.variables["input"]).toEqual({ stateId: "s-todo", assigneeId: null });
  });

  test("add makes a missing label, files in Todo, and answers the new id", async () => {
    const linear = fakeLinear();
    const id = await run(
      Effect.flatMap(linear.tracker, (tracker) =>
        tracker.add({
          project: "foreman",
          title: "new",
          description: "text",
          labels: ["size:2", "bug"],
        }),
      ),
    );
    expect(id).toBe("foreman#ENG-500");
    const create = linear.calls.find((call) => call.document.includes("issueCreate"));
    expect(create?.variables["input"]).toEqual({
      teamId: "t-1",
      projectId: "p-1",
      title: "new",
      description: "text",
      stateId: "s-todo",
      labelIds: ["l-size", "l-new"],
    });
  });

  test("add with proposed files in Triage", async () => {
    const linear = fakeLinear();
    await run(
      Effect.flatMap(linear.tracker, (tracker) =>
        tracker.add({
          project: "foreman",
          title: "idea",
          description: "text",
          labels: [],
          status: "proposed",
        }),
      ),
    );
    const create = linear.calls.find((call) => call.document.includes("issueCreate"));
    expect(create?.variables["input"]).toMatchObject({ stateId: "s-triage" });
  });

  test("add with proposed refuses a team with no triage state, before creating anything", async () => {
    const linear = fakeLinear({ states: STATES.filter((state) => state.type !== "triage") });
    const error = await run(
      Effect.flip(
        Effect.flatMap(linear.tracker, (tracker) =>
          tracker.add({
            project: "foreman",
            title: "idea",
            description: "text",
            labels: [],
            status: "proposed",
          }),
        ),
      ),
    );
    expect(error).toBeInstanceOf(TrackerError);
    expect(linear.calls.some((call) => call.document.includes("issueCreate"))).toBe(false);
  });

  test("logs come oldest first", async () => {
    const linear = fakeLinear({ issues: [node(1)] });
    const logs = await run(
      Effect.flatMap(linear.tracker, (tracker) => tracker.logs("foreman#ENG-1")),
    );
    expect(logs.map((entry) => entry.message)).toEqual(["ghost: first", "Ann: second"]);
  });
});

describe("linearTracker reads", () => {
  test("an issue closed on Linear after foreman claimed it reads done", async () => {
    const linear = fakeLinear({ issues: [node(1), node(2)] });
    const result = await run(
      Effect.gen(function* () {
        const tracker = yield* linear.tracker;
        yield* tracker.claim("foreman#ENG-1");
        yield* tracker.lookup("foreman#ENG-1");
        linear.issues.set("ENG-1", node(1, { state: { type: "completed" } }));
        yield* tracker.refresh("foreman");
        return {
          shown: yield* tracker.lookup("foreman#ENG-1"),
          ready: yield* tracker.ready("foreman"),
        };
      }),
    );
    expect(Option.map(result.shown, (item) => item.status)).toEqual(Option.some("done"));
    expect(result.ready.map((item) => item.id)).toEqual(["foreman#ENG-2"]);
  });

  test("more held issues than one id filter takes are all read", async () => {
    const closed = Array.from({ length: 150 }, (_, index) =>
      node(1000 + index, { state: { type: "completed" } }),
    );
    const linear = fakeLinear({ closed });
    const listed = await run(
      Effect.gen(function* () {
        const tracker = yield* linear.tracker;
        yield* Effect.forEach(closed, (issue) => tracker.lookup(`foreman#${issue.identifier}`));
        yield* tracker.refresh("foreman");
        return yield* tracker.list({ project: "foreman", status: "done" });
      }),
    );
    expect(listed).toHaveLength(150);
  });

  test("below a tenth of the request budget, refresh reads on every fifth call", async () => {
    const linear = fakeLinear({
      issues: [node(1)],
      rate: {
        requests: { remaining: 100, limit: 1500 },
        complexity: undefined,
        reset: Date.now() + 3_600_000,
      },
    });
    await run(
      Effect.gen(function* () {
        const tracker = yield* linear.tracker;
        for (let call = 0; call < 6; call += 1) yield* tracker.refresh("foreman");
      }),
    );
    expect(linear.calls.filter((call) => call.document.includes("viewer {"))).toHaveLength(2);
  });
});
