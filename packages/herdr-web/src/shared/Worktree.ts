// A repository's checkouts, as `git worktree list` gives them, with the
// space that shows each one.
import { Schema } from "effect"

export const Checkout = Schema.Struct({
  /** The checkout's folder on its machine. */
  path: Schema.String,
  /** None for a detached head. */
  branch: Schema.Option(Schema.String),
  /** The repository's own checkout, which is never removed. */
  isMain: Schema.Boolean,
  /** The space whose folder is in this checkout, addressed as the page addresses spaces; none when no space shows it. */
  space: Schema.Option(Schema.String),
})
export type Checkout = typeof Checkout.Type

export const RepoCheckouts = Schema.Struct({
  /** The main checkout's folder name, as herdr-app names a repository. */
  repo: Schema.String,
  /** The main checkout first, then the others in git's order. */
  checkouts: Schema.Array(Checkout),
})
export type RepoCheckouts = typeof RepoCheckouts.Type
