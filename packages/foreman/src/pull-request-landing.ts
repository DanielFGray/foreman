/**
 * Where a task at a pull-request land block stands, read from GitHub each
 * tick (docs/issue-trackers.md, sections 3 and 4).
 *
 * No pull request is stored. foreman finds it by its head branch, as it
 * finds the worktree by the branch, so this reading is the whole of the
 * landing's state.
 */
import type { PullRequest, RequiredChecks } from "./github.ts";
import type { Step } from "./policy.ts";

/**
 * What the pull request of the task's branch says about the approved commit.
 *
 * - `Unpublished`: no open PR, or an open one whose head is behind the
 *   approved commit. Publish pushes the commit, and opens a PR when none is open.
 * - `Open`: an open PR whose head is the approved commit.
 * - `Moved`: an open PR whose head is a commit the approval did not read.
 * - `Merged`: a PR of the branch merged. The work is on the remote trunk.
 * - `Closed`: a PR at the approved commit was closed without a merge.
 * - `Unreadable`: GitHub did not answer, or the project cannot post its
 *   review kind. The task takes no step there.
 */
export type PullRequestReading =
  | { readonly _tag: "Unpublished"; readonly open: PullRequest | undefined }
  | { readonly _tag: "Open"; readonly pr: PullRequest; readonly checks: RequiredChecks }
  | { readonly _tag: "Moved"; readonly pr: PullRequest }
  | { readonly _tag: "Merged"; readonly pr: PullRequest }
  | { readonly _tag: "Closed"; readonly pr: PullRequest }
  | { readonly _tag: "Unreadable"; readonly detail: string };

/**
 * A reading before its required checks are read: `Ready` is an open PR at the
 * approved commit, which becomes `Open` with its checks.
 */
export type Located =
  | Exclude<PullRequestReading, { readonly _tag: "Open" | "Unreadable" }>
  | { readonly _tag: "Ready"; readonly pr: PullRequest };

/**
 * Which pull request of the branch decides, and what it says. An open PR
 * decides first, then a merged one, then a closed one at the approved commit.
 * A PR closed at another commit belongs to an earlier lap and is passed over,
 * so a requeued task's publish opens a new one.
 *
 * `behind` says whether an open PR's head is an ancestor of the approved
 * commit, which git answers: then the head is the task's own older commit, and
 * publish pushes the new one.
 */
export const readingOf = (
  pulls: ReadonlyArray<PullRequest>,
  approved: string,
  behind: (head: string) => boolean,
): Located => {
  const open = pulls.find((pr) => pr.state === "OPEN");
  if (open !== undefined) {
    if (open.head === approved) return { _tag: "Ready", pr: open };
    return behind(open.head) ? { _tag: "Unpublished", open } : { _tag: "Moved", pr: open };
  }
  const merged = pulls.find((pr) => pr.state === "MERGED");
  if (merged !== undefined) return { _tag: "Merged", pr: merged };
  const closed = pulls.find((pr) => pr.state === "CLOSED" && pr.head === approved);
  if (closed !== undefined) return { _tag: "Closed", pr: closed };
  return { _tag: "Unpublished", open: undefined };
};

/**
 * The policy step a reading waits on. `publish` gates the push and the PR;
 * `land` gates the merge. The rest has one right answer each and takes no
 * step: a moved head is fetched, a merged PR completes the task, a closed one
 * does what the project's setting says. Land `off` still completes a task the
 * operator merged on GitHub, so completion cannot wait for the land step.
 */
export const stepOf = (reading: PullRequestReading): Step | undefined => {
  switch (reading._tag) {
    case "Unpublished":
      return "publish";
    case "Open":
      return "land";
    case "Moved":
    case "Merged":
    case "Closed":
    case "Unreadable":
      return undefined;
  }
};

/**
 * The `mergeStateStatus` values a merge can go through on: clean, clean but
 * for pre-receive hooks, and failing only checks that are not required.
 */
export const MERGEABLE: ReadonlySet<string> = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/** The issue number a PR body closes: the task's own, when the task is an issue of the same repo. */
export const closingLine = (task: string, tracker: string): string | undefined => {
  const number = /#(\d+)$/.exec(task)?.[1];
  return tracker === "github" && number !== undefined ? `Closes #${number}` : undefined;
};
