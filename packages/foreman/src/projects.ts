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
  readonly projects: ReadonlyArray<Omit<Project, "verify">>;
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
