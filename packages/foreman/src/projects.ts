import { Effect } from "effect";
import { dirname } from "node:path";
import type { Fleet } from "./fleet.ts";
import type { Repository } from "./repository.ts";

/**
 * The projects foreman works in, derived from the world every tick.
 *
 * A project is a git checkout, named for the prog project its tasks live in:
 * the checkout's own folder name. The operator states which projects are in
 * play by keeping a herdr-app space open in them, so there is no list to keep
 * in step with the spaces.
 *
 * Two sets, because opening and closing a space are routine clicks:
 *
 * - **open** — a space is in the checkout. Only these take new work.
 * - **managed** — open, plus every checkout a foreman agent still runs in.
 *   Settling, review, landing and the sweep read this set, so closing a space
 *   drains the work already under way instead of stranding it.
 */
export interface Project {
  readonly name: string;
  readonly directory: string;

  /** The project's own check, `scripts/verify.sh`, when it keeps one. */
  readonly verify: string | undefined;

  /** The project's own dev server, `scripts/preview.sh`, when it keeps one. It runs in a task's worktree. */
  readonly preview: string | undefined;

  /** A space is open in this checkout, so new work may start here. */
  readonly open: boolean;
}

/** Two checkouts answer to one project name, so neither is worked in. */
export interface Ambiguous {
  readonly name: string;
  readonly directories: ReadonlyArray<string>;
}

/**
 * The project set from the checkouts open spaces sit in and the checkouts
 * running agents belong to.
 *
 * A name that two checkouts share is ambiguous rather than resolved: tasks
 * name a project, not a directory, so picking one would land work in whichever
 * checkout happened to sort first.
 */
export const projectSet = (
  open: ReadonlyArray<string>,
  running: ReadonlyArray<string>,
): {
  readonly projects: ReadonlyArray<Omit<Project, "verify" | "preview">>;
  readonly ambiguous: ReadonlyArray<Ambiguous>;
} => {
  const opened = new Set(open);
  const directories = [...new Set([...open, ...running])];
  const byName = new Map<string, Array<string>>();
  for (const directory of directories) {
    const name = nameOf(directory);
    byName.set(name, [...(byName.get(name) ?? []), directory]);
  }
  const projects = [...byName].flatMap(([name, found]) =>
    found.length === 1 ? [{ name, directory: found[0]!, open: opened.has(found[0]!) }] : [],
  );
  const ambiguous = [...byName].flatMap(([name, found]) =>
    found.length > 1 ? [{ name, directories: found }] : [],
  );
  return { projects, ambiguous };
};

const nameOf = (directory: string) => directory.replace(/\/+$/, "").split("/").pop() ?? directory;

/**
 * The project a git common directory belongs to. Every checkout and linked
 * worktree of one repository shares that directory, so `/build/foo/.git` is
 * project `foo`, and a space inside a task's worktree names its checkout's
 * project. Same rule as `Repository.checkoutOf`, which gives the checkout folder.
 */
export const projectOf = (commonDir: string) => nameOf(dirname(commonDir));

/** The checkouts the operator's open spaces sit in: the projects that take new work. */
export const openCheckouts = (fleet: Fleet["Service"], repository: Repository["Service"]) =>
  Effect.gen(function* () {
    const folders = yield* fleet.spaces;
    const checkouts = yield* Effect.forEach(folders, (folder) => repository.checkoutOf(folder), {
      concurrency: "unbounded",
    });
    return checkouts.filter((checkout) => checkout !== undefined);
  });
