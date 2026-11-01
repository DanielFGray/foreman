import { Effect, Option } from "effect"
import { expect, test } from "vitest"
import { parseStatus, readSpaceGits } from "./SpaceGit.ts"

const OID = "# branch.oid 3f1c9a6e2d4b8a7c5e0f1a2b3c4d5e6f7a8b9c0d"

/** Answers git's three reads for a folder: the checkout's top, its status, and its common directory. */
const gitIn = (answers: Readonly<Record<string, Readonly<{ top: string; status: string; common: string }>>>) => ({
  exec: ({ argv, cwd }: { argv: ReadonlyArray<string>; cwd: Option.Option<string> }) => {
    const answer = answers[Option.getOrElse(cwd, () => "")]
    const command = argv.join(" ")
    const stdout = !answer
      ? undefined
      : command.includes("--show-toplevel")
        ? answer.top
        : command.includes("status")
          ? answer.status
          : answer.common
    return Effect.succeed({ code: Option.some(stdout === undefined ? 128 : 0), stdout: stdout ?? "", stderr: "", truncated: false, timed_out: false })
  },
})

test("a space's project is the one foreman names for its git common directory, from a linked worktree too", async () => {
  const hc = gitIn({
    "/build/prog": { top: "/build/prog\n", status: `${OID}\n# branch.head main\n`, common: "/build/prog/.git\n" },
    "/home/me/.local/state/foreman/worktrees/prog/ts-1": {
      top: "/home/me/.local/state/foreman/worktrees/prog/ts-1\n",
      status: `${OID}\n# branch.head foreman/ts-1\n`,
      common: "/build/prog/.git\n",
    },
  })
  const git = await Effect.runPromise(
    readSpaceGits(
      hc,
      [
        { id: "s1", folder: "/build/prog", on: Option.none() },
        { id: "s2", folder: "/home/me/.local/state/foreman/worktrees/prog/ts-1", on: Option.none() },
      ],
      {},
    ),
  )
  expect(git["s1"]?.project).toEqual(Option.some("prog"))
  expect(git["s2"]?.project).toEqual(Option.some("prog"))
  expect(git["s2"]?.branch).toEqual(Option.some("foreman/ts-1"))
})

test("a clean branch has a name and no changes", () => {
  const out = [OID, "# branch.head main", "# branch.upstream origin/main", "# branch.ab +0 -0", ""].join("\n")
  expect(parseStatus(out)).toEqual({ branch: Option.some("main"), changed: false })
})

test("a modified, renamed and untracked path each mark the tree changed", () => {
  const out = [
    OID,
    "# branch.head feat/sidebar",
    "# branch.upstream origin/feat/sidebar",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d 1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d src/page/sidebar.ts",
    "2 R. N... 100644 100644 100644 1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d 1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d R100 new.ts\told.ts",
    "? notes.md",
    "",
  ].join("\n")
  expect(parseStatus(out)).toEqual({ branch: Option.some("feat/sidebar"), changed: true })
})

test("a detached head has no branch", () => {
  const out = [OID, "# branch.head (detached)", ""].join("\n")
  expect(parseStatus(out)).toEqual({ branch: Option.none(), changed: false })
})

test("an untracked file alone marks the tree changed", () => {
  const out = [OID, "# branch.head main", "? scratch.log", ""].join("\n")
  expect(parseStatus(out)).toEqual({ branch: Option.some("main"), changed: true })
})

test("a branch with no commits yet keeps its name", () => {
  const out = ["# branch.oid (initial)", "# branch.head trunk", "? README.md", ""].join("\n")
  expect(parseStatus(out)).toEqual({ branch: Option.some("trunk"), changed: true })
})
