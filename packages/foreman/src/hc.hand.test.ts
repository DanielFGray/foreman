import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { Fleet, type Worker } from "./fleet.ts";
import { finishedForeman, liveHand } from "./hand-fixture.ts";
import { hcFleetOver, type Terminal } from "./hc.ts";
import { Repository } from "./repository.ts";

type Request = { readonly method: string; readonly params: Record<string, unknown> };
type Calls = { readonly requests: Array<Request>; left: boolean };

/**
 * HcFleet over a fake `hc connect`. It answers `terminal.list` from `terminals`
 * with hc's label equality and live-only rule, and records every request. Other
 * methods get an empty result. The repository records whether a branch was left.
 */
const withFakeHc = <A>(
  terminals: ReadonlyArray<Terminal>,
  use: (fleet: Fleet["Service"], calls: Calls) => Effect.Effect<A, unknown>,
): Promise<A> => {
  const state: Calls = { requests: [], left: false };
  const encode = (text: string) => Stream.make(new TextEncoder().encode(text));
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const { options } = command as unknown as {
        options: { stdin: Stream.Stream<Uint8Array> | { stream: Stream.Stream<Uint8Array> } };
      };
      const stdin = options.stdin;
      const input = "stream" in stdin ? stdin.stream : stdin;
      const request = JSON.parse(yield* Stream.mkString(Stream.decodeText(input))) as Request;
      state.requests.push(request);
      const labels = (request.params.labels as Record<string, string> | undefined) ?? {};
      const result =
        request.method === "terminal.list"
          ? {
              terminals: terminals.filter(
                (terminal) =>
                  (request.params.all === true || terminal.state === "live") &&
                  Object.entries(labels).every(([key, value]) => terminal.labels[key] === value),
              ),
            }
          : {};
      const stdout = JSON.stringify({ result });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: undefined as never,
        stdout: encode(stdout),
        stderr: encode(""),
        all: encode(stdout),
        getInputFd: () => undefined as never,
        getOutputFd: () => encode(""),
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const repository = {
    leaveBranch: () =>
      Effect.sync(() => {
        state.left = true;
      }),
    worktrees: () => Effect.succeed([]),
    removeWorktree: () => Effect.void,
  } as unknown as Repository["Service"];
  const layer = hcFleetOver().pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provide(Layer.succeed(Repository, repository)),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* Fleet, state);
    }).pipe(Effect.provide(layer)),
  );
};

describe("a live hand terminal over a finished foreman one", () => {
  test("the roster reads the coordinator's agent as the task's worker", async () => {
    const roster: ReadonlyArray<Worker> = await withFakeHc(
      [finishedForeman, liveHand],
      (fleet) => fleet.roster,
    );
    expect(roster.map((worker) => [worker.task, worker.owner])).toEqual([["ts-1", "hand"]]);
  });

  test("spawn refuses the role the coordinator's agent is working, and starts nothing", async () => {
    const { refused, started } = await withFakeHc([finishedForeman, liveHand], (fleet, calls) =>
      Effect.gen(function* () {
        const [worker] = yield* fleet.roster;
        const refused = yield* Effect.exit(
          fleet.spawn(worker!, { kind: "claude", model: undefined, prompt: "x", role: "author" }),
        );
        return {
          refused,
          started: calls.requests.some((request) => request.method === "terminal.run"),
        };
      }),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    expect(JSON.stringify(refused)).toContain("hand-started author in t2");
    expect(started).toBe(false);
  });

  test("close leaves the coordinator's workspace alone: no end of its terminal, no branch left", async () => {
    const calls = await withFakeHc([finishedForeman, liveHand], (fleet, state) =>
      fleet.close({ task: "ts-1", repository: "/build/proj" }).pipe(Effect.as(state)),
    );
    const ended = calls.requests
      .filter((request) => request.method === "terminal.kill" || request.method === "terminal.rm")
      .map((request) => request.params.terminal);
    expect(ended).not.toContain("t2");
    expect(calls.left).toBe(false);
  });
});
