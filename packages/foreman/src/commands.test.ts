import { describe, expect, test } from "bun:test";
import { Effect, Option, Stdio, Stream, SubscriptionRef } from "effect";
import {
  type Caller,
  dispatchQueued,
  fileTask,
  type Dispatching,
  type Filing,
} from "./commands.ts";
import { type Authored, EMPTY_FLEET, type FleetState } from "./dispatcher.ts";
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

interface Setup {
  readonly stdin?: string;
  readonly queued?: ReadonlyArray<Item>;
  /** Whether the caller runs in a fleet worker's terminal. */
  readonly worker?: boolean;
  /** What the dispatcher's author answers; it starts the rung asked for, else `cheap`. */
  readonly answer?: Authored;
}

/**
 * The doubles one command runs against: a tracker that answers `FILED`, a
 * dispatcher whose reading queues `queued` and whose author answers `answer`,
 * and a caller that is or is not a fleet worker. Each records what it was asked.
 */
const doubles = (setup: Setup) =>
  Effect.gen(function* () {
    const added: Array<Added> = [];
    const authored: Array<{ task: string; rung: Option.Option<string> }> = [];
    const tracker: Pick<Tracker["Service"], "add"> = {
      add: (filed) => Effect.sync(() => (added.push(filed), FILED)),
    };
    const dispatcher: Dispatching = {
      read: Effect.void,
      state: yield* SubscriptionRef.make<FleetState>({
        ...EMPTY_FLEET,
        queue: setup.queued ?? [],
      }),
      author: (queued, rung) =>
        Effect.sync((): Authored => {
          authored.push({ task: queued.id, rung });
          return setup.answer ?? { _tag: "Started", rung: Option.getOrElse(rung, () => "cheap") };
        }),
    };
    const caller: Caller = { inWorker: Effect.succeed(setup.worker ?? false) };
    return { tracker, dispatcher, caller, added, authored };
  });

/** Runs one command over the doubles, and answers its refusal and what each double was asked. */
const run = (
  setup: Setup,
  command: (
    made: Effect.Success<ReturnType<typeof doubles>>,
  ) => Effect.Effect<void, Effect.Error<ReturnType<typeof fileTask>>, Stdio.Stdio>,
) =>
  Effect.gen(function* () {
    const made = yield* doubles(setup);
    const refused = yield* command(made).pipe(
      Effect.as(Option.none<string>()),
      Effect.catchTag("Refused", (refusal) => Effect.succeedSome(refusal.detail)),
    );
    return { refused, added: made.added, authored: made.authored };
  }).pipe(
    Effect.provide(
      Stdio.layerTest({ stdin: Stream.make(new TextEncoder().encode(setup.stdin ?? "")) }),
    ),
    Effect.runPromise,
  );

/** Runs `foreman add` with `filing` over the defaults. */
const file = (filing: Partial<Filing>, setup: Setup) =>
  run(setup, ({ tracker, dispatcher, caller }) =>
    fileTask(
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
      caller,
    ),
  );

/** Runs `foreman dispatch <id>`. */
const dispatch = (id: string, setup: Setup) =>
  run(setup, ({ dispatcher, caller }) => dispatchQueued(dispatcher, caller, id, Option.none()));

const NO_BLOCK: Authored = { _tag: "NoAuthorBlock", project: "fibrae" };
const NO_BLOCK_REASON = "fibrae's pipeline is stopped, or the task's route has no author block";
const WORKER_REFUSAL =
  "a fleet worker files tasks but never dispatches them: run foreman add without --dispatch, and the operator dispatches";

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
    expect(authored).toEqual([{ task: FILED, rung: Option.some("strong") }]);
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
      {
        queued: [task(FILED)],
        answer: { _tag: "UnknownRung", rung: "missing", rungs: ["cheap", "strong"] },
      },
    );
    expect(refused).toEqual(
      Option.some(
        `${FILED} is filed but not dispatched: no dispatchable rung missing; rungs: cheap, strong`,
      ),
    );
    expect(added).toHaveLength(1);
  });

  test("an author that starts nothing is refused after filing, with its reason", async () => {
    const { refused, added } = await file(
      { dispatch: true },
      { queued: [task(FILED)], answer: NO_BLOCK },
    );
    expect(refused).toEqual(
      Option.some(`${FILED} is filed but not dispatched: ${NO_BLOCK_REASON}`),
    );
    expect(added).toHaveLength(1);
  });

  test("a fleet worker files a task", async () => {
    const { refused, added } = await file({}, { worker: true });
    expect(refused).toEqual(Option.none());
    expect(added).toHaveLength(1);
  });

  test("a fleet worker's --dispatch is refused before anything is filed", async () => {
    const { refused, added, authored } = await file(
      { dispatch: true },
      { worker: true, queued: [task(FILED)] },
    );
    expect(refused).toEqual(Option.some(WORKER_REFUSAL));
    expect(added).toEqual([]);
    expect(authored).toEqual([]);
  });
});

describe("foreman dispatch", () => {
  test("the operator starts a queued task's author", async () => {
    const { refused, authored } = await dispatch("ts-1", { queued: [task("ts-1")] });
    expect(refused).toEqual(Option.none());
    expect(authored).toEqual([{ task: "ts-1", rung: Option.none() }]);
  });

  test("a fleet worker is refused, and no author is asked", async () => {
    const { refused, authored } = await dispatch("ts-1", {
      worker: true,
      queued: [task("ts-1")],
    });
    expect(refused).toEqual(Option.some(WORKER_REFUSAL));
    expect(authored).toEqual([]);
  });

  test("an author that starts nothing is refused with its reason, not reported dispatched", async () => {
    const { refused } = await dispatch("ts-1", { queued: [task("ts-1")], answer: NO_BLOCK });
    expect(refused).toEqual(Option.some(NO_BLOCK_REASON));
  });
});
