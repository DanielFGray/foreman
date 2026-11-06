import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Option, PlatformError } from "effect";
import { Machine } from "./machine.ts";

type Proc = {
  readonly meminfo?: string;
  readonly processes?: Record<string, { readonly cwd: string; readonly statm: string }>;
};

/**
 * A `/proc` that holds only what a test puts in it. Every read is recorded when
 * it runs, so a test can assert what Machine did not touch as well as what it
 * returned.
 */
const fakeProc = (proc: Proc) => {
  const reads: string[] = [];
  const files = new Map<string, string>();
  const links = new Map<string, string>();
  if (proc.meminfo !== undefined) files.set("/proc/meminfo", proc.meminfo);
  const processes = Object.entries(proc.processes ?? {});
  for (const [pid, entry] of processes) {
    files.set(`/proc/${pid}/statm`, entry.statm);
    links.set(`/proc/${pid}/cwd`, entry.cwd);
  }
  const notFound = (method: string, path: string) =>
    PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
    });
  const lookup = <T>(table: Map<string, T>, method: string, path: string) =>
    Effect.suspend(() => {
      reads.push(path);
      const hit = table.get(path);
      return hit === undefined ? Effect.fail(notFound(method, path)) : Effect.succeed(hit);
    });
  const fs = FileSystem.makeNoop({
    readFileString: (path) => lookup(files, "readFileString", path),
    readLink: (path) => lookup(links, "readLink", path),
    readDirectory: (path) =>
      Effect.suspend(() => {
        reads.push(path);
        return path === "/proc"
          ? Effect.succeed([...processes.map(([pid]) => pid), "self", "meminfo"])
          : Effect.fail(notFound("readDirectory", path));
      }),
  });
  return { fs, reads };
};

const withMachine = <A>(
  proc: Proc,
  use: (m: Effect.Success<typeof Machine.make>) => Effect.Effect<A>,
) => {
  const { fs, reads } = fakeProc(proc);
  return Effect.runPromise(
    Effect.gen(function* () {
      const m = yield* Machine.make;
      return yield* use(m);
    }).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
  ).then((value) => ({ value, reads }));
};

describe("Machine.available", () => {
  test("reads MemAvailable as bytes", async () => {
    const { value } = await withMachine(
      { meminfo: "MemTotal: 1000 kB\nMemAvailable:    8137080 kB\nBuffers: 1 kB\n" },
      (m) => m.available,
    );
    expect(value).toEqual(Option.some(8137080 * 1024));
  });

  test("a meminfo without MemAvailable is none", async () => {
    const { value } = await withMachine({ meminfo: "MemTotal: 1000 kB\n" }, (m) => m.available);
    expect(value).toEqual(Option.none());
  });

  test("an unreadable meminfo is none", async () => {
    const { value } = await withMachine({}, (m) => m.available);
    expect(value).toEqual(Option.none());
  });
});

describe("Machine.residentUnder", () => {
  // Pages are 4096 bytes: 75 pages is 307200 bytes, 10 pages is 40960 bytes.
  const processes = {
    "10": { cwd: "/wt/a/packages", statm: "100 50 0 0 0 0 0\n" },
    "11": { cwd: "/wt/a", statm: "100 25 0 0 0 0 0\n" },
    "12": { cwd: "/wt/b", statm: "100 10 0 0 0 0 0\n" },
    "13": { cwd: "/elsewhere", statm: "100 99 0 0 0 0 0\n" },
  };

  test("sums RSS under each worktree, including children, in bytes", async () => {
    const { value } = await withMachine({ processes }, (m) => m.residentUnder(["/wt/a", "/wt/b"]));
    expect(value.get("/wt/a")).toBe(307200);
    expect(value.get("/wt/b")).toBe(40960);
    expect(value.has("/elsewhere")).toBe(false);
  });

  test("a process under nested directories counts toward the longest", async () => {
    const { value } = await withMachine(
      { processes: { "20": { cwd: "/a/b/c", statm: "100 3 0 0 0 0 0\n" } } },
      (m) => m.residentUnder(["/a", "/a/b"]),
    );
    expect(value.get("/a/b")).toBe(12288);
    expect(value.has("/a")).toBe(false);
  });

  test("a process with a malformed statm is left out", async () => {
    const { value } = await withMachine(
      {
        processes: {
          "30": { cwd: "/wt/a", statm: "100\n" },
          "31": { cwd: "/wt/a", statm: "100 2 0 0 0 0 0\n" },
        },
      },
      (m) => m.residentUnder(["/wt/a"]),
    );
    expect(value.get("/wt/a")).toBe(8192);
  });

  test("no directories reads nothing from /proc", async () => {
    const { value, reads } = await withMachine({ processes }, (m) => m.residentUnder([]));
    expect([...value]).toEqual([]);
    expect(reads).toEqual([]);
  });
});
