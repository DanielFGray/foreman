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
     * Opens the workspace for a task, resolving in order: a workspace already
     * carrying this task's label, else a worktree git still has registered for
     * this task's branch — attaching a fresh workspace to it — else creating
     * both from the repository's HEAD.
     *
     * The worktree is the durable identity and the workspace a view onto it.
     * A workspace dies when its last pane closes, but the worktree and branch
     * survive, so resolution reads the durable record second. Without that
     * step, a task whose workspace a keypress destroyed fell through to
     * `worktree create`, which fails on a directory that already exists — and
     * retried that same collision forever instead of re-adopting the work.
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

    /** Starts an agent on the workspace's own pane, or a fresh split for a reviewer. */
    readonly spawn: (
      worker: Worker,
      options: SpawnOptions,
    ) => Effect.Effect<AgentIdentity, FleetError>;

    /**
     * Every workspace labelled `foreman/*`, whatever daemon opened it.
     *
     * A label records no ownership, and two daemons against different configs
     * are not competing for the same slots — so the adapter reports everything
     * and the dispatcher scopes it to the config's project set, which is the
     * only ownership the world records.
     */
    readonly roster: Effect.Effect<ReadonlyArray<Worker>, FleetError>;

    /** Brings a task's workspace to the front so a human can take over. */
    readonly focus: (worker: Worker) => Effect.Effect<void, FleetError>;

    /** Stops one live role while leaving its workspace and worktree available. */
    readonly stop: (worker: Worker, role: AgentRole) => Effect.Effect<void, FleetError>;

    /**
     * Closes a task's workspace, removing the worktree when foreman made one.
     * The branch survives either way.
     *
     * Resolution mirrors `open`: the workspace carrying the task's label, else
     * a worktree git still has for its branch. The workspace half only needs
     * the multiplexer; the worktree half re-adopts the worktree to get a
     * workspace to remove it with — so a worktree whose workspace already
     * closed, its last pane closed by hand, is removed rather than orphaned.
     */
    readonly close: (options: CloseOptions) => Effect.Effect<void, FleetError>;

    /**
     * Notifies the operator, but only when foreman's own workspace is not the
     * focused one. Telling someone about a thing already on their screen
     * trains them to dismiss notifications without reading them.
     *
     * Two rules decide what may come through here, and both exist because they
     * were broken at once and the fleet dinged on every poll.
     *
     * **Only what foreman itself did.** An agent that blocked, stopped or
     * handed off is herdr's event: herdr sees it first and already alerts.
     * Foreman announces what herdr cannot know — a branch that landed, a task
     * that climbed onto the operator, a merge that was undone.
     *
     * **Only on a transition, never on a condition.** A tick reads the whole
     * world back, so a notification on a path that writes nothing fires again
     * on the next tick, and every tick after. If the code reaching this call
     * has not written to the task store or the checkout, it must not call it.
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

export interface CloseOptions {
  readonly task: string;

  /**
   * The project's main checkout, needed only when the workspace is gone and
   * the worktree must be adopted to be removed.
   */
  readonly repository: string | undefined;
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

/**
 * What an agent is in a workspace for. One live agent per role, so a role is
 * also the name of the pane its agent runs in.
 *
 * The pipeline's two are `author` and `review`; a plan run's two are `planner`
 * and `tasker`. They are four roles rather than two because the second agent in
 * a workspace reads what the first one produced, and calling the tasker an
 * author would have it refuse the pane the planner is still sitting in.
 */
export const AgentRole = Schema.Literal("author", "review", "planner", "tasker");
export type AgentRole = Schema.Schema.Type<typeof AgentRole>;

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
   * What the multiplexer sees in the pane each role runs in, for the roles
   * that have one.
   *
   * A worker carries every role at once so a task reads as its author while it
   * is written and as its reviewer once it is handed off; the caller picks the
   * one it is asking about — `workerFor` takes what the task store says is
   * active, a plan run takes its current stage. No pane address is kept here: a
   * dispatch is refused from the pane list itself, and dismissing the author
   * means closing the workspace, which needs only the workspace id.
   */
  readonly roles: ReadonlyMap<AgentRole, WorkerState>;
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
  `${stateDirectory()}/worktrees/${project}/${task}`;

/**
 * Where a project's landings are proved before they are applied.
 *
 * One per project, not one per task: it is a scratch checkout, and landings
 * are serialised by the tick anyway. Reusing it is what lets the project's
 * installed dependencies survive between landings, which is the difference
 * between a verification run and a full cold install every time.
 */
export const verifyDirectoryFor = (project: string): string =>
  `${stateDirectory()}/verify/${project}`;

const stateDirectory = () =>
  `${process.env["XDG_STATE_HOME"] ?? `${process.env["HOME"]}/.local/state`}/foreman`;
