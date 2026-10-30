// Each space's git state, read from the space's folder on its own machine
// with `git status --porcelain=v2 --branch`, run through hc's machine.exec.
import { Array, Effect, Option, Record, String } from "effect"
import type { Hc } from "../hc/Hc.ts"
import type { SpaceGit } from "../shared/Fleet.ts"

/** A space whose git state is to be read. `on` names its machine; none is this one. */
export type GitTarget = Readonly<{ id: string; folder: string; on: Option.Option<string> }>

/** How many git processes run at once. */
const CONCURRENCY = 4

/** Seconds before git is ended; a folder on a slow disk or network mount gives up. */
const TIMEOUT = 10

/**
 * The git state of every target. A target whose folder git does not answer for
 * has no entry. When hc itself fails for a target, `last` is kept for it.
 */
export const readSpaceGits = (hc: Hc["Service"], targets: ReadonlyArray<GitTarget>, last: Readonly<Record<string, SpaceGit>>) =>
  Effect.forEach(
    targets,
    (target) => Effect.map(readSpaceGit(hc, target, Record.get(last, target.id)), (git) => Option.map(git, (value) => [target.id, value] as const)),
    { concurrency: CONCURRENCY },
  ).pipe(Effect.map((entries) => Record.fromEntries(Array.getSomes(entries))))

/** Git's answer for one folder, or `fallback` when hc could not run it. */
const readSpaceGit = (hc: Hc["Service"], { id, folder, on }: GitTarget, fallback: Option.Option<SpaceGit>) =>
  // An empty folder would run git where hc runs, not where the space is.
  !String.isNonEmpty(folder)
    ? Effect.succeed(Option.none<SpaceGit>())
    : hc.exec({ argv: ["git", "status", "--porcelain=v2", "--branch"], cwd: Option.some(folder), on, timeout: Option.some(TIMEOUT) }).pipe(
        // A folder that is no repository exits nonzero, and git may be missing: both are ordinary.
        Effect.map(({ code, timed_out, stdout }) => (!timed_out && Option.contains(code, 0) ? Option.some(parseStatus(stdout)) : Option.none())),
        Effect.catchTag("HcError", (error) =>
          error.kind === "spawn_failed"
            ? Effect.succeed(Option.none<SpaceGit>())
            : Effect.as(Effect.logWarning(`cannot read git state of ${id}`, error.message), fallback),
        ),
      )

/**
 * Reads `git status --porcelain=v2 --branch`. Header lines start with `#`; any
 * other line is a changed, renamed, unmerged or untracked path. The branch is
 * none for a detached head.
 */
export const parseStatus = (stdout: string): SpaceGit => {
  const lines = Array.filter(String.split("\n")(stdout), String.isNonEmpty)
  const head = Array.findFirst(lines, String.startsWith(HEAD))
  return {
    branch: Option.filter(Option.map(head, String.slice(HEAD.length)), (name) => name !== DETACHED),
    changed: Array.some(lines, (line) => !String.startsWith("#")(line)),
  }
}

const HEAD = "# branch.head "
const DETACHED = "(detached)"
