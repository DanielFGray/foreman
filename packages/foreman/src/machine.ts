import { BunServices } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Option } from "effect";

/**
 * What the machine still has free, and what each worktree is holding.
 *
 * Linux `/proc` is the source: `MemAvailable` for free RAM, and each process's
 * `cwd` plus `statm` resident pages for attribution. A process whose cwd sits
 * under a worktree counts toward that worktree — including the agent's
 * children, which is where the spikes are (a bun test run under a worktree is
 * that task's cost). Foreman shows these figures; it never refuses a dispatch
 * over them.
 */
export class Machine extends Context.Service<Machine>()("Machine", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    /**
     * Bytes the kernel still has for new work (`MemAvailable`), or none when
     * `/proc/meminfo` is unreadable or names no such field.
     */
    const available: Effect.Effect<Option.Option<number>> = fs.readFileString("/proc/meminfo").pipe(
      Effect.map(memAvailableOf),
      Effect.orElseSucceed(() => Option.none<number>()),
    );

    /**
     * Resident set attributed to each of `directories`, keyed by the directory
     * itself. A process whose cwd equals a directory or sits under it counts
     * toward the longest matching directory; processes that match none are
     * ignored. Unreadable `/proc` entries are skipped, so a denied pid never
     * fails the reading.
     */
    const residentUnder = (
      directories: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, number>> => {
      if (directories.length === 0) return Effect.succeed(new Map());
      const normalized = directories.map(stripTrailingSlash);
      return fs.readDirectory("/proc").pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(
            entries.filter((entry) => /^\d+$/.test(entry)),
            (pid) =>
              Effect.gen(function* () {
                const cwd = yield* fs.readLink(`/proc/${pid}/cwd`).pipe(Effect.option);
                if (Option.isNone(cwd)) return Option.none<readonly [string, number]>();
                const owner = ownerOf(cwd.value, normalized);
                if (owner === undefined) return Option.none<readonly [string, number]>();
                const statm = yield* fs.readFileString(`/proc/${pid}/statm`).pipe(Effect.option);
                if (Option.isNone(statm)) return Option.none<readonly [string, number]>();
                const pages = rssPagesOf(statm.value);
                if (Option.isNone(pages)) return Option.none<readonly [string, number]>();
                return Option.some([owner, pages.value * PAGE_SIZE] as const);
              }),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.map((rows) => {
          const totals = new Map<string, number>();
          for (const row of rows) {
            if (Option.isNone(row)) continue;
            const [directory, bytes] = row.value;
            totals.set(directory, (totals.get(directory) ?? 0) + bytes);
          }
          return totals as ReadonlyMap<string, number>;
        }),
        Effect.orElseSucceed(() => new Map() as ReadonlyMap<string, number>),
      );
    };

    return { available, residentUnder } as const;
  }),
}) {
  static readonly Default = Layer.effect(this, this.make).pipe(Layer.provide(BunServices.layer));
}

/** Linux page size in bytes; x86_64 and aarch64 Linux both use 4096. */
export const PAGE_SIZE = 4096;

/** Bytes of `MemAvailable` from a `/proc/meminfo` body, or none when absent. */
export const memAvailableOf = (text: string): Option.Option<number> => {
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(text);
  return match === null ? Option.none() : Option.some(Number(match[1]) * 1024);
};

/** Resident pages from a `/proc/[pid]/statm` body, or none when malformed. */
export const rssPagesOf = (text: string): Option.Option<number> => {
  const field = text.trim().split(/\s+/)[1];
  if (field === undefined || !/^\d+$/.test(field)) return Option.none();
  return Option.some(Number(field));
};

/**
 * The longest of `directories` that contains `cwd`, or undefined when none do.
 * Equality counts as containment, so a process whose cwd is the worktree root
 * is attributed to it.
 */
export const ownerOf = (cwd: string, directories: ReadonlyArray<string>): string | undefined => {
  const path = stripTrailingSlash(cwd);
  let best: string | undefined;
  for (const directory of directories) {
    if (path === directory || path.startsWith(`${directory}/`)) {
      if (best === undefined || directory.length > best.length) best = directory;
    }
  }
  return best;
};

const stripTrailingSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/, "") : path;
