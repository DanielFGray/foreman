import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Exit, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner, type CommandLine } from "effect/process";
import { Fleet } from "./fleet.ts";
import { hcFleetOver } from "./hc.ts";
import { Repository } from "./repository.ts";

const terminal = (labels: Record<string, string>) => ({
  address: "t9",
  cwd: "/build/proj",
  state: "live",
  created_ms: 1,
  labels,
});

/**
 * Asks HcFleet whether the caller is a worker, with `env` as the environment
 * and a scripted `hc connect` that prints `reply`. Answers the exit and every
 * argument list hc was run with.
 */
const ask = (env: Record<string, string>, reply: string) => {
  const ran: Array<ReadonlyArray<CommandLine.Word>> = [];
  const encode = (text: string) => Stream.make(new TextEncoder().encode(text));
  const spawner = ChildProcessSpawner.make((command) => {
    ran.push(ChildProcess.isStandardCommand(command) ? command.args : []);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: encode(reply),
        stderr: encode(""),
        all: encode(reply),
        getInputFd: () => Sink.drain,
        getOutputFd: () => encode(""),
        unref: Effect.succeed(Effect.void),
      }),
    );
  });
  const layer = hcFleetOver().pipe(
    Layer.provide(Repository.Default),
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );
  return Effect.runPromiseExit(
    Fleet.use((fleet) => fleet.inWorker).pipe(
      Effect.provide(Layer.mergeAll(layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
    ),
  ).then((exit) => ({ exit, ran }));
};

describe("HcFleet.inWorker", () => {
  test("a process outside hc is the operator's, and hc is not asked", async () => {
    const { exit, ran } = await ask({}, "");
    expect(exit).toEqual(Exit.succeed(false));
    expect(ran).toEqual([]);
  });

  test("a terminal foreman labelled as the fleet's is a worker", async () => {
    const { exit, ran } = await ask(
      { HC_TERMINAL_ID: "t9" },
      JSON.stringify({
        result: terminal({ "fm.fleet": "foreman", "fm.task": "ts-1", "fm.role": "author" }),
      }),
    );
    expect(exit).toEqual(Exit.succeed(true));
    expect(ran).toEqual([["connect"]]);
  });

  test("an hc terminal without the fleet label is the operator's", async () => {
    const { exit } = await ask(
      { HC_TERMINAL_ID: "t9" },
      JSON.stringify({ result: terminal({ where: "foreman / 1" }) }),
    );
    expect(exit).toEqual(Exit.succeed(false));
  });

  test("a terminal hc cannot describe is an error, not the operator", async () => {
    const { exit } = await ask(
      { HC_TERMINAL_ID: "t9" },
      JSON.stringify({
        error: { message: 'no terminal "t9"', data: { kind: "not_found" } },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
