import { describe, expect, test } from "bun:test";
import { Effect, Option, Stdio, Stream, SubscriptionRef } from "effect";
import { fileTask, type Dispatching, type Filing } from "./commands.ts";
import { EMPTY_FLEET, type FleetState } from "./dispatcher.ts";
import type { Item } from "./records.ts";
import type { Tracker } from "./tracker.ts";

const FILED = "ts-new";

const task = (id: string): Item => ({
  id,
  title: `task ${id}`,
  status: "open",
  project: "fibrae",
  type: "task",
  priority: 2,
  labels: [],
  description: "",
  parent: undefined,
  lastActivityAt: new Date(0),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  definitionOfDone: undefined,
  runs: [],
  charges: [],
  parked: undefined,
  tip: undefined,
});

type Added = Parameters<Tracker["Service"]["add"]>[0];

/**
 * Runs `foreman add` against a tracker that answers `FILED` and a dispatcher
 * whose reading queues `queued`, and answers what each was asked.
 */
const file = (filing: Partial<Filing>, options: { stdin?: string; queued?: ReadonlyArray<Item> }) =>
  Effect.gen(function* () {
    const added: Array<Added> = [];
    const authored: Array<{ task: string; rung: string | undefined }> = [];
    const tracker: Pick<Tracker["Service"], "add"> = {
      add: (filed) => Effect.sync(() => (added.push(filed), FILED)),
    };
    const dispatcher: Dispatching = {
      rungs: ["cheap", "strong"],
      read: Effect.void,
      state: yield* SubscriptionRef.make<FleetState>({
        ...EMPTY_FLEET,
        queue: options.queued ?? [],
      }),
      author: (queued, rung) => Effect.sync(() => void authored.push({ task: queued.id, rung })),
    };
    const outcome = yield* fileTask(
      {
        title: "a task",
        project: "fibrae",
        description: "",
        labels: [],
        dispatch: false,
        rung: Option.none(),
        ...filing,
      },
      tracker,
      dispatcher,
    ).pipe(
      Effect.as(Option.none<string>()),
      Effect.catchTag("Refused", (refused) => Effect.succeedSome(refused.detail)),
      Effect.provide(
        Stdio.layerTest({ stdin: Stream.make(new TextEncoder().encode(options.stdin ?? "")) }),
      ),
    );
    return { refused: outcome, added, authored };
  }).pipe(Effect.runPromise);

describe("foreman add", () => {
  test("- reads the description from stdin, without the newline a heredoc adds", async () => {
    const { refused, added } = await file(
      { description: "-", labels: ["size:2"] },
      { stdin: "what to do\nand when it is done\n" },
    );
    expect(refused).toEqual(Option.none());
    expect(added).toEqual([
      {
        project: "fibrae",
        title: "a task",
        description: "what to do\nand when it is done",
        labels: ["size:2"],
      },
    ]);
  });

  test("--rung without --dispatch is refused before anything is filed", async () => {
    const { refused, added } = await file({ rung: Option.some("cheap") }, {});
    expect(refused).toEqual(
      Option.some("--rung names the rung of a dispatch, so it needs --dispatch"),
    );
    expect(added).toEqual([]);
  });

  test("--dispatch hands the filed task to the author path, on the rung named", async () => {
    const { refused, authored } = await file(
      { dispatch: true, rung: Option.some("strong") },
      { queued: [task("ts-other"), task(FILED)] },
    );
    expect(refused).toEqual(Option.none());
    expect(authored).toEqual([{ task: FILED, rung: "strong" }]);
  });

  test("a refused dispatch names the task it left filed", async () => {
    const { refused, added, authored } = await file({ dispatch: true }, { queued: [] });
    expect(refused).toEqual(
      Option.some(
        `${FILED} is filed but not dispatched: ${FILED} is not in the queue; see foreman queue`,
      ),
    );
    expect(added).toHaveLength(1);
    expect(authored).toEqual([]);
  });

  test("an unknown rung is refused after filing, and names the task", async () => {
    const { refused, added } = await file(
      { dispatch: true, rung: Option.some("missing") },
      { queued: [task(FILED)] },
    );
    expect(refused).toEqual(
      Option.some(
        `${FILED} is filed but not dispatched: no dispatchable rung missing; rungs: cheap, strong`,
      ),
    );
    expect(added).toHaveLength(1);
  });
});
