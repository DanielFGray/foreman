import { Effect, Schema } from "effect";

/**
 * The multiplexer, as foreman needs it.
 *
 * One workspace per task, labelled `foreman/<task-id>`, living from dispatch
 * until the task leaves the fleet. Agents come and go inside it; the workspace
 * is the durable thing. That label is also how foreman knows what it is doing:
 * the roster is read back from the multiplexer every tick rather than
 * remembered, so foreman holds no state that a restart could lose.
 *
 * The multiplexer owns the git worktree too. It has to: the worktree and the
 * workspace showing it are one idea, and splitting them across two owners is
 * what put every worker in whichever window happened to be focused.
 */
export class Fleet extends Effect.Tag("Fleet")<
  Fleet,
  {
    /**
     * Opens the workspace for a task, creating its worktree and branch from
     * the repository's HEAD. Returns the existing one if it is already open,
     * so a restart adopts its workspaces instead of duplicating them.
     */
    readonly open: (options: OpenOptions) => Effect.Effect<Worker, FleetError>;

    /**
     * Opens a workspace on a repository checkout that already exists, rather
     * than on a worktree of it.
     *
     * Onboarding needs this: uncommitted work lives in the operator's checkout
     * and nowhere else, so an agent sent to salvage it has to stand in that
     * directory. Everything downstream is unchanged — the workspace carries a
     * task label, the roster reads it back, and the agent settles like any
     * other. Only teardown differs, because the checkout is not foreman's to
     * delete.
     */
    readonly attach: (options: AttachOptions) => Effect.Effect<Worker, FleetError>;

    /** Starts an agent on a fresh pane inside a task's workspace. */
    readonly spawn: (
      worker: Worker,
      options: SpawnOptions,
    ) => Effect.Effect<AgentIdentity, FleetError>;

    /** Every workspace foreman owns, with what the multiplexer sees in it. */
    readonly roster: Effect.Effect<ReadonlyArray<Worker>, FleetError>;

    /** Brings a task's workspace to the front so a human can take over. */
    readonly focus: (worker: Worker) => Effect.Effect<void, FleetError>;

    /**
     * Closes the workspace, removing the worktree when foreman made one. The
     * branch survives either way.
     */
    readonly close: (worker: Worker) => Effect.Effect<void, FleetError>;

    /**
     * Closes the pane one agent ran in, keeping the workspace and its worktree.
     *
     * What foreman owes an agent it has decided is finished with. Leaving the
     * pane alive is how a workspace ends up holding two agents on one task: the
     * abandoned one goes on running while the next dispatch splits a pane
     * beside it, and both edit the same directory.
     */
    readonly dismiss: (worker: Worker, role: AgentRole) => Effect.Effect<void, FleetError>;

    /**
     * Notifies the operator, but only when foreman's own workspace is not the
     * focused one. Telling someone about a thing already on their screen
     * trains them to dismiss notifications without reading them.
     */
    readonly notify: (title: string, body: string) => Effect.Effect<void, FleetError>;
  }
>() {}

export interface OpenOptions {
  readonly task: string;
  readonly repository: string;
  readonly branch: string;
  readonly directory: string;
}

export interface AttachOptions {
  readonly task: string;
  readonly repository: string;
}

export interface SpawnOptions {
  readonly kind: string;

  /**
   * Which model the harness must run, or undefined to let it choose.
   *
   * The ladder is meaningless without this. Two rungs can share a harness and
   * differ only here, and a dispatch that passes no model runs whatever the
   * program defaults to — so every rung would be the same rung.
   */
  readonly model: string | undefined;
  readonly prompt: string;
  readonly role: AgentRole;
}

/** The agent identity available after it accepts its task. */
export interface AgentIdentity {
  readonly kind: string;
  readonly model: string | undefined;
}

export type AgentRole = "author" | "review";

/**
 * A task's workspace, as the multiplexer currently sees it.
 *
 * Carries no role. The task store records author and active-reviewer labels;
 * storing the same fact here would let the two disagree after a restart.
 */
export interface Worker {
  readonly task: string;
  readonly workspace: string;
  readonly pane: string;
  readonly directory: string;

  /**
   * Set when the multiplexer made a worktree for this workspace, absent when
   * the workspace is attached to a checkout that was already there.
   *
   * Read back from the multiplexer every tick rather than remembered, because
   * it decides whether teardown may delete the directory — and getting that
   * from foreman's own memory is how you eventually delete somebody's work.
   */
  readonly worktree: string | undefined;
  readonly state: WorkerState;

  /**
   * The pane each role runs in, when the multiplexer has one.
   *
   * The pane rather than its state alone, because every decision foreman makes
   * about an agent needs to reach it: closing the one it has given up on, and
   * refusing to start a second one beside a live one. Keeping only the state
   * threw the address away and left both impossible.
   */
  readonly author: AgentPane | undefined;
  readonly review: AgentPane | undefined;
}

/**
 * One agent's pane.
 *
 * `session` is the harness's own resumable session id, which the multiplexer
 * detects — `ses_…` for opencode, a uuid for claude. It is the only identity
 * that outlives the process, so it is what distinguishes an agent foreman
 * dispatched and lost from one it never started.
 */
export interface AgentPane {
  readonly pane: string;
  readonly state: WorkerState;
  readonly session: string | undefined;
}

/**
 * `settled` covers both success and failure: an agent that stopped tells you
 * only that it stopped, and what actually happened is written in the task
 * store. `gone` means the workspace is empty — the pane was closed, by a crash
 * or by a human deciding to intervene, which are indistinguishable from here.
 */
export type WorkerState = "working" | "settled" | "blocked" | "gone";

export class FleetError extends Schema.TaggedError<FleetError>()("FleetError", {
  operation: Schema.String,
  detail: Schema.String,
}) {}

/** Namespaced so foreman's workspaces and branches are obvious at a glance. */
export const labelFor = (task: string): string => `foreman/${task}`;

/** The task a workspace belongs to, or undefined if it is not foreman's. */
export const taskOf = (label: string): string | undefined =>
  label.startsWith("foreman/") ? label.slice("foreman/".length) : undefined;

/**
 * Where a task's worktree lives. Under the state directory rather than inside
 * the repository: an in-tree worktree would mean editing .gitignore in every
 * project foreman touches, and a stray checkout is far more confusing inside a
 * repo than outside it.
 */
export const directoryFor = (project: string, task: string): string =>
  `${process.env["XDG_STATE_HOME"] ?? `${process.env["HOME"]}/.local/state`}/foreman/worktrees/${project}/${task}`;
