import { Option } from "effect"
import { expect, test } from "vitest"
import { parseStatus } from "./SpaceGit.ts"

const OID = "# branch.oid 3f1c9a6e2d4b8a7c5e0f1a2b3c4d5e6f7a8b9c0d"

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
