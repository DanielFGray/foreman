import { describe, expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { Fleet, type FleetError } from "./fleet.ts";
import { hcFleetOver } from "./hc.ts";
import { Repository } from "./repository.ts";

type Exit = { readonly code: number; readonly stdout: string } | "hang";

const terminal = (address: string, role: string, status: string | null) => ({
  address,
  cwd: "/state/worktrees/proj/ts-1",
  state: "live",
  created_ms: 1,
  status: status === null ? null : { state: status },
  labels: { "fm.fleet": "foreman", "fm.task": "ts-1", "fm.role": role, "fm.repo": "/build/proj" },
});

const turn = (address: string, ended: boolean) =>
  JSON.stringify({
    terminal: address,
    ended,
    reason: ended ? "status" : "timeout",
    status: ended ? "done" : null,
    turn: 1,
    exit_code: null,
  });

/**
 * HcFleet over a scripted `hc`: `hc connect` lists the given terminals and
 * `hc wait <address>` answers from `waits`. Records every `hc wait` argument list.
 */
const runWith = <A>(
  terminals: ReadonlyArray<ReturnType<typeof terminal>>,
  waits: Record<string, Exit>,
  use: (fleet: Fleet["Service"]) => Effect.Effect<A, FleetError>,
) => {
  const waited: Array<ReadonlyArray<string>> = [];
  const encode = (text: string) => Stream.make(new TextEncoder().encode(text));
  const spawner = ChildProcessSpawner.make((command) => {
    const { args } = command as unknown as { args: ReadonlyArray<string> };
    let out: Exit;
    if (args[0] === "wait") {
      waited.push(args);
      out = waits[args[1]!] ?? { code: 1, stdout: "" };
    } else {
      out = { code: 0, stdout: JSON.stringify({ result: { terminals } }) };
    }
    // "hang" is a wait that never answers: no exit, no output.
    const answer = out === "hang" ? undefined : out;
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: answer ? Effect.succeed(ChildProcessSpawner.ExitCode(answer.code)) : Effect.never,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: undefined as never,
        stdout: answer ? encode(answer.stdout) : Stream.never,
        stderr: encode(""),
        all: answer ? encode(answer.stdout) : Stream.never,
        getInputFd: () => undefined as never,
        getOutputFd: () => encode(""),
        unref: Effect.succeed(Effect.void),
      }),
    );
  });
  const layer = hcFleetOver().pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provide(Layer.succeed(Repository, {} as Repository["Service"])),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* Fleet);
    }).pipe(Effect.provide(layer)),
  ).then((value) => ({ value, waited }));
};

describe("HcFleet.awaitTurn", () => {
  test("waits on the working terminal through hc wait and returns at the turn end", async () => {
    const { waited } = await runWith(
      [terminal("t1", "author", "working")],
      { t1: { code: 0, stdout: turn("t1", true) } },
      (fleet) => fleet.awaitTurn("ts-1", undefined),
    );
    expect(waited).toEqual([["wait", "t1", "--json"]]);
  });

  test("returns on a check-in so the caller re-reads the roster", async () => {
    const { waited } = await runWith(
      [terminal("t1", "author", "working")],
      { t1: { code: 0, stdout: turn("t1", false) } },
      (fleet) => fleet.awaitTurn("ts-1", undefined),
    );
    expect(waited).toHaveLength(1);
  });

  test("does not call hc wait when nothing is working", async () => {
    const { waited } = await runWith(
      [terminal("t1", "author", "idle"), terminal("t2", "review", "blocked")],
      {},
      (fleet) => fleet.awaitTurn("ts-1", undefined),
    );
    expect(waited).toEqual([]);
  });

  test("waits only on the role asked for", async () => {
    const { waited } = await runWith(
      [terminal("t1", "author", "working"), terminal("t2", "review", "working")],
      { t2: { code: 0, stdout: turn("t2", true) } },
      (fleet) => fleet.awaitTurn("ts-1", "review"),
    );
    expect(waited).toEqual([["wait", "t2", "--json"]]);
  });

  test("treats a terminal that went away as a check-in", async () => {
    const stdout = JSON.stringify({ error: { kind: "not_found", message: "no terminal t1" } });
    await runWith([terminal("t1", "author", "working")], { t1: { code: 3, stdout } }, (fleet) =>
      fleet.awaitTurn("ts-1", undefined),
    );
  });

  test("fails on a turn reply that came with a non-zero exit", async () => {
    await expect(
      runWith(
        [terminal("t1", "author", "working")],
        { t1: { code: 2, stdout: turn("t1", true) } },
        (fleet) => fleet.awaitTurn("ts-1", undefined),
      ),
    ).rejects.toThrow(/hc wait exited 2/);
  });

  test("fails on an hc error other than a missing terminal", async () => {
    const stdout = JSON.stringify({ error: { kind: "internal", message: "boom" } });
    await expect(
      runWith([terminal("t1", "author", "working")], { t1: { code: 1, stdout } }, (fleet) =>
        fleet.awaitTurn("ts-1", undefined),
      ),
    ).rejects.toThrow(/boom/);
  });

  test("ends on the first wait to fail while another still blocks", async () => {
    const stdout = JSON.stringify({ error: { kind: "internal", message: "boom" } });
    await expect(
      runWith(
        [terminal("t1", "author", "working"), terminal("t2", "review", "working")],
        { t1: "hang", t2: { code: 1, stdout } },
        (fleet) => fleet.awaitTurn("ts-1", undefined),
      ),
    ).rejects.toThrow(/boom/);
  });
});
