// A space's git worktrees: list the repository's checkouts, check out a
// branch and open it as a space, open a checkout no space shows, and remove a
// clean checkout. Git runs through hc on the space's own machine. Checkouts
// go where herdr-app's worktree mod puts them, so both apps see the same ones.
import { Array, Config, Context, Effect, Layer, Option, Order, Schema, String } from "effect"
import { Hc } from "../hc/Hc.ts"
import type { LayoutDoc } from "../hc/LayoutDoc.ts"
import type { Checkout, RepoCheckouts } from "../shared/Worktree.ts"
import { HerdrApp, localOf, qualified } from "./HerdrApp.ts"

/** Git refused, or the space is in no repository, or the checkout may not go. */
export class WorktreeError extends Schema.TaggedError<WorktreeError, { readonly brand: unique symbol }>()("WorktreeError", {
  message: Schema.String,
}) {}

export class Worktrees extends Context.Service<Worktrees>()("herdr-web/server/Worktrees", {
  make: Effect.gen(function* () {
    const hc = yield* Hc
    const app = yield* HerdrApp
    const home = yield* Config.String("HOME")

    /** Git's output, trimmed; a nonzero exit fails with what git wrote. */
    const git = (on: Option.Option<string>, cwd: string, args: ReadonlyArray<string>) =>
      Effect.flatMap(run(on, cwd, args), ({ isOk, stdout, stderr }) =>
        isOk ? Effect.succeed(String.trimEnd(stdout)) : Effect.fail(new WorktreeError({ message: Option.getOrElse(firstLine(stderr), () => `git ${args.join(" ")} failed`) })),
      )

    /** Whether git exits 0: for the commands whose answer is their exit code. */
    const succeeds = (on: Option.Option<string>, cwd: string, args: ReadonlyArray<string>) => Effect.map(run(on, cwd, args), ({ isOk }) => isOk)

    const run = (on: Option.Option<string>, cwd: string, args: ReadonlyArray<string>) =>
      Effect.map(hc.exec({ argv: ["git", ...args], cwd: Option.some(cwd), on, timeout: Option.some(GIT_TIMEOUT) }), ({ code, timed_out, stdout, stderr }) => ({
        isOk: !timed_out && Option.contains(code, 0),
        stdout,
        stderr,
      }))

    // Another machine's home, where its checkouts go, is that machine's $HOME.
    const homeOn = (on: Option.Option<string>) =>
      Option.isNone(on)
        ? Effect.succeed(home)
        : Effect.flatMap(hc.exec({ argv: ["sh", "-c", 'printf %s "$HOME"'], cwd: Option.none(), on, timeout: Option.some(GIT_TIMEOUT) }), ({ code, stdout }) =>
            Option.contains(code, 0) && String.isNonEmpty(stdout) ? Effect.succeed(stdout) : Effect.fail(new WorktreeError({ message: "the other machine's home folder is not known" })),
          )

    /** The space's layout, its repository's main checkout and name, and its machine. */
    const repoOf = (space: string) =>
      Effect.gen(function* () {
        const { on, id } = localOf(space)
        const { doc } = yield* hc.layout(on)
        const folder = yield* Effect.fromOption(Option.map(Array.findFirst(doc.spaces, (one) => one.id === id), ({ folder }) => folder)).pipe(
          Effect.mapError(() => new WorktreeError({ message: `no space ${space}` })),
        )
        const common = yield* git(on, folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
          Effect.mapError(() => new WorktreeError({ message: `${folder} is in no git repository` })),
        )
        const main = String.endsWith("/.git")(common) ? common.slice(0, -"/.git".length) : common
        return { on, doc, main, name: Option.getOrElse(Array.last(String.split(main, "/")), () => main) }
      })

    const list = (space: string) =>
      Effect.gen(function* () {
        const { on, doc, main, name } = yield* repoOf(space)
        const listed = parseWorktreeList(yield* git(on, main, ["worktree", "list", "--porcelain"]))
        return { repo: name, checkouts: withSpaces(listed, doc, on) } satisfies RepoCheckouts
      })

    return {
      list,
      /**
       * Checks out the branch, a new one from the space's HEAD when it does not
       * exist, in `~/.herdr/worktrees/<repo>/<branch>`, and opens it as a space
       * whose pane runs `program`. The space has no name of its own, so it shows
       * the checkout's folder, as herdr-app's do.
       */
      create: (space: string, branch: string, program: Option.Option<string>) =>
        Effect.gen(function* () {
          const { on, main, name } = yield* repoOf(space)
          const wanted = String.trim(branch)
          yield* git(on, main, ["check-ref-format", "--branch", wanted]).pipe(Effect.mapError(() => new WorktreeError({ message: `"${wanted}" is no branch name` })))
          const path = `${yield* homeOn(on)}/.herdr/worktrees/${name}/${slug(wanted)}`
          const exists = yield* succeeds(on, main, ["show-ref", "--verify", "--quiet", `refs/heads/${wanted}`])
          yield* git(on, main, exists ? ["worktree", "add", path, wanted] : ["worktree", "add", "-b", wanted, path, "HEAD"])
          return yield* app.newSpace({ on, folder: path, name: "", program })
        }),
      /** Opens a checkout of the space's repository as a new space. */
      open: (space: string, path: string) =>
        Effect.gen(function* () {
          const { on } = localOf(space)
          const checkout = yield* findCheckout(yield* list(space), path)
          return yield* app.newSpace({ on, folder: checkout.path, name: "", program: Option.none() })
        }),
      /**
       * Removes a checkout that has no uncommitted changes, without force, so
       * git refuses one that holds anything it would lose. The branch stays.
       * The spaces that showed it close after git removed it.
       */
      remove: (space: string, path: string) =>
        Effect.gen(function* () {
          const { on, main } = yield* repoOf(space)
          const checkout = yield* findCheckout(yield* list(space), path)
          if (checkout.isMain) {
            return yield* new WorktreeError({ message: "the repository's own checkout stays" })
          }
          const changes = yield* git(on, checkout.path, ["status", "--porcelain"])
          if (String.isNonEmpty(changes)) {
            return yield* new WorktreeError({ message: `${checkout.path} has uncommitted changes` })
          }
          yield* git(on, main, ["worktree", "remove", checkout.path])
          yield* Effect.forEach(Option.toArray(checkout.space), app.closeSpace, { discard: true })
        }),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

/** Seconds before git is ended. */
const GIT_TIMEOUT = 30

const findCheckout = ({ checkouts }: RepoCheckouts, path: string) =>
  Effect.fromOption(Array.findFirst(checkouts, (one) => one.path === path)).pipe(Effect.mapError(() => new WorktreeError({ message: `${path} is no checkout of this repository` })))

const firstLine = (text: string) => Array.findFirst(String.split(String.trim(text), "\n"), String.isNonEmpty)

/** A branch as a folder name: what is not a letter, digit, dot, dash or underscore becomes a dash, as herdr-app writes it. */
export const slug = (branch: string) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")

/**
 * Reads `git worktree list --porcelain`: one block per checkout, the main one
 * first. A bare repository and a checkout whose folder is gone are left out.
 */
export const parseWorktreeList = (porcelain: string): ReadonlyArray<Omit<Checkout, "space">> =>
  Array.getSomes(
    Array.map(String.split(porcelain, /\n\n+/), (block, index) => {
      const lines = String.split(block, "\n")
      const field = (key: string) => Option.map(Array.findFirst(lines, String.startsWith(`${key} `)), String.slice(key.length + 1))
      return Array.some(lines, (line) => line === "bare" || String.startsWith("prunable")(line))
        ? Option.none()
        : Option.map(field("worktree"), (path) => ({ path, branch: Option.map(field("branch"), String.replace(/^refs\/heads\//, "")), isMain: index === 0 }))
    }),
  )

/**
 * Each checkout with the space whose folder is in it. A folder inside two
 * checkouts, one nested in the other, belongs to the deeper one.
 */
export const withSpaces = (checkouts: ReadonlyArray<Omit<Checkout, "space">>, doc: LayoutDoc, on: Option.Option<string>): ReadonlyArray<Checkout> => {
  const holder = (folder: string) =>
    Array.head(Array.sort(Array.filter(checkouts, ({ path }) => isInside(folder, path)), deeperFirst))
  return Array.map(checkouts, (checkout) => ({
    ...checkout,
    space: Option.map(
      Array.findFirst(doc.spaces, ({ folder }) => Option.exists(holder(folder), ({ path }) => path === checkout.path)),
      ({ id }) => qualified(on, id),
    ),
  }))
}

const isInside = (folder: string, dir: string) => folder === dir || String.startsWith(`${dir}/`)(folder)

const deeperFirst = Order.mapInput(Order.flip(Order.Number), ({ path }: Readonly<{ path: string }>) => path.length)
