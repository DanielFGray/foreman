// A repository's checkouts, as `git worktree list` gives them, with the
// space that shows each one.
import { Schema as S } from "effect"

export const Checkout = S.Struct({
  /** The checkout's folder on its machine. */
  path: S.String,
  /** None for a detached head. */
  branch: S.Option(S.String),
  /** The repository's own checkout, which is never removed. */
  isMain: S.Boolean,
  /** The space whose folder is in this checkout, addressed as the page addresses spaces; none when no space shows it. */
  space: S.Option(S.String),
})
export type Checkout = typeof Checkout.Type

export const RepoCheckouts = S.Struct({
  /** The main checkout's folder name, as herdr-app names a repository. */
  repo: S.String,
  /** The main checkout first, then the others in git's order. */
  checkouts: S.Array(Checkout),
})
export type RepoCheckouts = typeof RepoCheckouts.Type
