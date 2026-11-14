/**
 * The wire shapes of the published reading: what `state.json` holds and what
 * the UI contract sends. Schemas only, with no I/O, so the page can import them.
 */
import { Schema as S } from "effect";
import { BOARD_COLUMNS } from "./board-columns.ts";
import { MODES, Policy, STEP_MODES, STEPS, TRACKERS } from "./policy.ts";
import { VIEWS } from "./view-names.ts";

/**
 * Bumped whenever a field a reader relies on changes meaning or goes away.
 * The herdr-app Foreman pane (`herdr/foreman/main.js`) checks it.
 */
export const PUBLISHED_VERSION = 7;

/**
 * The views the file carries: foreman's own. The queue is read on demand, not
 * stored here: it is the task store's ready list as foreman ranks it, read
 * with `foreman queue` or `queueOf`, so a reader shows it for the project it
 * is looking at.
 */
export const PUBLISHED_VIEWS = VIEWS.filter((view) => view !== "queue");

/**
 * A task's pull request as a reader sees it (`pullRequestView`): `waiting`
 * names what holds the merge, `checks` sums up its required checks.
 */
export const PublishedPullRequest = S.Struct({
  number: S.Int,
  url: S.String,
  state: S.Literals(["open", "merged", "closed"]),
  checks: S.NullOr(S.Literals(["pending", "passing", "failing"])),
  waiting: S.NullOr(S.Literals(["checks", "you", "github"])),
});
export type PublishedPullRequest = typeof PublishedPullRequest.Type;

/** Where a task lives on the web: its page in its tracker, and its pull request. */
const Links = {
  url: S.NullOr(S.String),
  pr: S.NullOr(PublishedPullRequest),
};

export const PublishedRow = S.Struct({
  view: S.Literals(VIEWS),
  key: S.String,
  label: S.String,
  detail: S.NullOr(S.String),
  project: S.NullOr(S.String),
  /** The epic the row's task sits under, so a reader can group a queue by it. */
  parent: S.NullOr(S.String),
  /** Whether the row is an epic, which takes no launch: an epic has no branch and no worker. */
  epic: S.Boolean,
  /** The one-shot subcommands this row takes: `foreman <action> <key>`. */
  actions: S.Array(S.String),
  ...Links,
});
export type PublishedRow = typeof PublishedRow.Type;

/**
 * Where one task stands at a block of its project's pipeline. `state` is the
 * run's state at a work block, or `parked` at a park block; `gates` are the
 * gates that hold it before that block, in route order.
 */
export const PublishedPlacement = S.Struct({
  key: S.String,
  label: S.String,
  project: S.String,
  /** The epic the task sits under; `epics` describes it while it is being driven. */
  parent: S.NullOr(S.String),
  node: S.String,
  /** The block a board draws the task on (`stands` on a placement); `node` is the block it waits for or runs at. */
  stands: S.String,
  /** `gone`: its last exit is one the drawing lacks (`ExitGone`), so it waits for the operator. */
  state: S.Literals(["waiting", "running", "ended", "parked", "gone", "idle"]),
  gates: S.Array(S.Struct({ id: S.String, step: S.String })),
  /** The board column the task shows in (`columnOf`). */
  column: S.Literals(BOARD_COLUMNS),
  ...Links,
  /**
   * The grant that lets the dispatcher take some of the project's
   * `grantSteps` for the task, and how many tasks it admits still.
   */
  grant: S.NullOr(S.Struct({ scope: S.String, steps: S.Array(S.String), left: S.NullOr(S.Int) })),
  /**
   * The task's runs, oldest first: the block each ran at, its role, its rung,
   * whether it is still open, and how it ended. A closed run that foreman did
   * not settle has no ending; a run stored without a block has no block.
   */
  runs: S.Array(
    S.Struct({
      node: S.NullOr(S.String),
      role: S.Literals(["author", "review", "check"]),
      rung: S.NullOr(S.String),
      open: S.Boolean,
      ending: S.NullOr(S.String),
    }),
  ),
});
export type PublishedPlacement = typeof PublishedPlacement.Type;

/**
 * What the dispatcher is doing: the policy's mode while it runs (`modeOf`), or
 * `failed` while its host waits to start it again, with why it stopped.
 */
export const DispatcherStatus = S.Union([
  S.Struct({ state: S.Literals(MODES) }),
  S.Struct({ state: S.Literal("failed"), detail: S.String }),
]);
export type DispatcherStatus = typeof DispatcherStatus.Type;

export const Published = S.Struct({
  version: S.Literal(PUBLISHED_VERSION),
  /**
   * The dispatcher that made this reading, or null for a one-shot
   * `foreman status`, which runs none and so cannot say what one is doing.
   */
  dispatcher: S.NullOr(DispatcherStatus),
  /** The policy the reading decided from; `foreman policy` changes it. */
  policy: Policy,
  /** Why the policy file could not be read, which pauses the fleet. */
  policyError: S.NullOr(S.String),
  /** ISO instant of the reading, or null before the first one completes. */
  observedAt: S.NullOr(S.String),
  /**
   * Bytes of free RAM (`MemAvailable`), or null when `/proc` could not be
   * read. The status line shows it beside the reading's age.
   */
  availableMemory: S.NullOr(S.Finite),
  /**
   * Resident set attributed to each live worker's worktree, keyed by task id.
   * The status line sums these; a free figure below the largest one hints that
   * another worker would not fit.
   */
  workerMemory: S.Record(S.String, S.Finite),
  /**
   * The managed projects and their checkouts, for a reader that offers a
   * choice of project. `grantSteps` are the steps a grant from a board gives a
   * task (`gatedSteps`); a reader takes no drop where they are empty.
   * `tracker` keeps the project's tasks, `repo` is the GitHub repo they live
   * in, and `unreachable` says why the tracker did not answer this reading,
   * which holds the project. `steps` is the mode each step has for this
   * project, as the dispatcher reads it (`modeFor`).
   */
  projects: S.Array(
    S.Struct({
      name: S.String,
      directory: S.String,
      grantSteps: S.Array(S.String),
      tracker: S.Literals(TRACKERS),
      repo: S.NullOr(S.String),
      unreachable: S.NullOr(S.String),
      steps: S.Record(S.Literals(STEPS), S.Literals(STEP_MODES)),
    }),
  ),
  /**
   * Each account the ladder and the reviewers draw on, with the rungs and the
   * reviewers it pays for. The quota rows describe the same accounts by
   * `provider`.
   */
  accounts: S.Array(
    S.Struct({ provider: S.String, rungs: S.Array(S.String), reviewers: S.Array(S.String) }),
  ),
  rows: S.Array(PublishedRow),
  /**
   * Each task that stands at a block, in the order the dispatcher placed
   * them: the queue first, in dispatch order. A task outside any pipeline is
   * left out.
   */
  placements: S.Array(PublishedPlacement),
  /** The projects whose pipeline cannot run, and why. Such a project places no task. */
  stopped: S.Array(S.Struct({ project: S.String, problems: S.Array(S.String) })),
  /** The board's Landed column: tasks that landed in the last `LANDED_HOURS`, newest first. */
  landed: S.Array(
    S.Struct({
      key: S.String,
      label: S.String,
      project: S.String,
      parent: S.NullOr(S.String),
      landedAt: S.String,
    }),
  ),
  /**
   * The epics being driven that a queued or claimed task sits under, and how
   * many of their direct children are done, for a reader that groups tasks
   * by epic.
   */
  epics: S.Array(
    S.Struct({ key: S.String, label: S.String, project: S.String, done: S.Int, total: S.Int }),
  ),
});
export type Published = typeof Published.Type;
