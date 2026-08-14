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
    readonly spawn: (worker: Worker, options: SpawnOptions) => Effect.Effect<void, FleetError>;

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
  readonly prompt: string;
  readonly role: "author" | "review";
}

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
  readonly authorState: WorkerState | undefined;
  readonly reviewState: WorkerState | undefined;
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
