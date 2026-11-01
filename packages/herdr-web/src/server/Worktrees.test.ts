import { describe, expect, test } from "vitest"
import { Option, Schema as S } from "effect"
import { LayoutDoc } from "../hc/LayoutDoc.ts"
import { parseWorktreeList, slug, withSpaces } from "./Worktrees.ts"

const PORCELAIN = [
  "worktree /src/app\nHEAD 1111\nbranch refs/heads/main",
  "worktree /home/u/.herdr/worktrees/app/feat-login\nHEAD 2222\nbranch refs/heads/feat/login",
  "worktree /home/u/.herdr/worktrees/app/spike\nHEAD 3333\ndetached",
  "worktree /tmp/gone\nHEAD 4444\nbranch refs/heads/old\nprunable gitdir file points to non-existent location",
].join("\n\n")

describe("parseWorktreeList", () => {
  test("reads each checkout, the main one first, and leaves out one whose folder is gone", () => {
    expect(parseWorktreeList(PORCELAIN)).toEqual([
      { path: "/src/app", branch: Option.some("main"), isMain: true },
      { path: "/home/u/.herdr/worktrees/app/feat-login", branch: Option.some("feat/login"), isMain: false },
      { path: "/home/u/.herdr/worktrees/app/spike", branch: Option.none(), isMain: false },
    ])
  })

  test("a bare repository has no checkout of its own", () => {
    expect(parseWorktreeList("worktree /srv/app.git\nbare\n\nworktree /src/app-wt\nHEAD 1\nbranch refs/heads/x")).toEqual([
      { path: "/src/app-wt", branch: Option.some("x"), isMain: false },
    ])
  })
})

test("a branch becomes a folder name as herdr-app writes it", () => {
  expect([slug("feat/login"), slug("fix: the bug!"), slug("v1.2_rc")]).toEqual(["feat-login", "fix-the-bug", "v1.2_rc"])
})

test("each checkout shows the space whose folder is in it, the deeper checkout winning", () => {
  const doc = S.decodeSync(LayoutDoc)({
    spaces: [
      { id: "sp1", name: "", folder: "/src/app/web", tabs: [] },
      { id: "sp2", name: "", folder: "/src/app/wt/x", tabs: [] },
      { id: "sp3", name: "", folder: "/elsewhere", tabs: [] },
    ],
  })
  const checkouts = [
    { path: "/src/app", branch: Option.some("main"), isMain: true },
    { path: "/src/app/wt/x", branch: Option.some("x"), isMain: false },
    { path: "/src/app/wt/y", branch: Option.some("y"), isMain: false },
  ]
  expect(withSpaces(checkouts, doc, Option.some("cynic")).map(({ space }) => space)).toEqual([Option.some("cynic/sp1"), Option.some("cynic/sp2"), Option.none()])
})
