import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Option } from "effect";
import { Machine, PAGE_SIZE, memAvailableOf, ownerOf, rssPagesOf } from "./machine.ts";

describe("memAvailableOf", () => {
  test("reads MemAvailable as bytes", () => {
    expect(
      memAvailableOf("MemTotal: 1000 kB\nMemAvailable:    8137080 kB\nBuffers: 1 kB\n"),
    ).toEqual(Option.some(8137080 * 1024));
  });

  test("absent MemAvailable is none", () => {
    expect(memAvailableOf("MemTotal: 1000 kB\n")).toEqual(Option.none());
  });
});

describe("rssPagesOf", () => {
  test("the second field is resident pages", () => {
    expect(rssPagesOf("1587 579 552 7 0 151 0\n")).toEqual(Option.some(579));
  });

  test("a short line is none", () => {
    expect(rssPagesOf("1587\n")).toEqual(Option.none());
  });
});

describe("ownerOf", () => {
  const dirs = ["/state/worktrees/foreman/ts-aaaaaa", "/state/worktrees/foreman/ts-bbbbbb"];

  test("a cwd inside a worktree belongs to it", () => {
    expect(ownerOf("/state/worktrees/foreman/ts-aaaaaa/packages/foreman", dirs)).toBe(
      "/state/worktrees/foreman/ts-aaaaaa",
    );
  });

  test("the worktree root itself belongs to it", () => {
    expect(ownerOf("/state/worktrees/foreman/ts-bbbbbb", dirs)).toBe(
      "/state/worktrees/foreman/ts-bbbbbb",
    );
  });

  test("the longest match wins when one directory nests under another", () => {
    expect(ownerOf("/a/b/c", ["/a", "/a/b"])).toBe("/a/b");
  });

  test("a cwd outside every directory is nobody's", () => {
    expect(ownerOf("/home/dan/build/foreman", dirs)).toBeUndefined();
  });
});

describe("Machine over a pretend /proc", () => {
  const files: Record<string, string> = {
    "/proc/meminfo": "MemAvailable:       2048 kB\n",
    "/proc/10/statm": "100 50 0 0 0 0 0\n",
    "/proc/11/statm": "100 25 0 0 0 0 0\n",
    "/proc/12/statm": "100 10 0 0 0 0 0\n",
  };
  const links: Record<string, string> = {
    "/proc/10/cwd": "/wt/a/packages",
    "/proc/11/cwd": "/wt/a",
    "/proc/12/cwd": "/wt/b",
    "/proc/13/cwd": "/elsewhere",
  };
  const notFound = (method: string, path: string) =>
    Effect.fail({
      _tag: "SystemError",
      reason: "NotFound",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
    } as never);
  const fs = FileSystem.makeNoop({
    readFileString: (path) =>
      path in files ? Effect.succeed(files[path]!) : notFound("readFileString", path),
    readLink: (path) => (path in links ? Effect.succeed(links[path]!) : notFound("readLink", path)),
    readDirectory: (path) =>
      path === "/proc"
        ? Effect.succeed(["10", "11", "12", "13", "self", "meminfo"])
        : notFound("readDirectory", path),
  });

  const withMachine = <A, E>(
    use: (m: Effect.Success<typeof Machine.make>) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const m = yield* Machine.make;
        return yield* use(m);
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    );

  test("available reads MemAvailable", async () => {
    expect(await withMachine((m) => m.available)).toEqual(Option.some(2048 * 1024));
  });

  test("residentUnder sums RSS under each worktree, including children", async () => {
    const totals = await withMachine((m) => m.residentUnder(["/wt/a", "/wt/b"]));
    expect(totals.get("/wt/a")).toBe((50 + 25) * PAGE_SIZE);
    expect(totals.get("/wt/b")).toBe(10 * PAGE_SIZE);
    expect(totals.has("/elsewhere")).toBe(false);
  });

  test("an empty directory list asks /proc nothing", async () => {
    expect([...(await withMachine((m) => m.residentUnder([])))]).toEqual([]);
  });
});
