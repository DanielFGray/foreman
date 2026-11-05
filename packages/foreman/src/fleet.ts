import { Context, Effect, Option, Schema } from "effect";

/**
 * The multiplexer, as foreman needs it.
 *
 * A task's workspace is its git worktree plus the agents running in it. The
 * worktree is the durable thing; agents come and go inside it, each one
 * labelled with its task and role. Those labels are how foreman knows what it
 * is doing: the roster is read back from the multiplexer every tick rather
 * than remembered, so foreman holds no state that a restart could lose.
 */
export class Fleet extends Context.Service<
  Fleet,
  {
    /**
     * Opens the workspace for a task, resolving in order: a worker already
     * running for it, else a worktree git still has registered for this
     * task's branch, else a new worktree with the branch cut from HEAD. A
     * `directory` that is the repository itself puts the operator's checkout
     * on the branch instead of making a worktree (branch mode).
     *
     * The worktree is the durable identity, and the agents in it come and go.
     * Without the second step, a task whose agents all ended fell through to
     * creating a worktree on a directory that already exists — and retried
     * that same collision forever instead of re-adopting the work.
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

    /** Starts an agent for one role, beside any other role's agent on the task. */
    readonly spawn: (
      worker: Worker,
      options: SpawnOptions,
    ) => Effect.Effect<AgentIdentity, FleetError>;

    /**
     * Every task with agents, whatever dispatcher started them.
     *
     * A label records no ownership, and two dispatchers against different configs
     * are not competing for the same slots — so the adapter reports everything
     * and the dispatcher scopes it to the config's project set, which is the
     * only ownership the world records.
     */
    readonly roster: Effect.Effect<ReadonlyArray<Worker>, FleetError>;

    /**
     * Blocks until one of a task's working agents for the role (every role when
     * undefined) ends its turn, or a check-in passes, or its terminal goes away.
     * Returns at once when none is working.
     *
     * The caller reads the roster again after each return, and calls this again
     * while any agent still works. A blocked agent is not working, so this does
     * not wait on it.
     */
    readonly awaitTurn: (
      task: string,
      role: AgentRole | undefined,
    ) => Effect.Effect<void, FleetError>;

    /**
     * The folders of the operator's open spaces on this machine — where the
     * projects foreman works in come from (`src/projects.ts`). A multiplexer
     * that cannot be read is an error, never an empty list: no spaces and an
     * unanswered question must not look alike.
     */
    readonly spaces: Effect.Effect<ReadonlyArray<string>, FleetError>;

    /**
     * Sends a message to one live role's agent, returning once it is working
     * on it. How an agent is steered or sent a correction without anyone
     * looking its pane up by hand.
     */
    readonly say: (
      worker: Worker,
      role: AgentRole,
      text: string,
    ) => Effect.Effect<void, FleetError>;

    /**
     * The last `lines` of history above a role's screen, as text, or none when
     * the role has no terminal to read.
     *
     * How a stopped agent is read for the message its harness printed on the
     * way out, since a harness that runs out of allowance exits with no error the
     * multiplexer can see.
     */
    readonly screen: (
      worker: Worker,
      role: AgentRole,
      lines: number,
    ) => Effect.Effect<Option.Option<string>, FleetError>;

    /**
     * Runs `command` in the task's worktree, in a terminal named
     * `preview-<task>`, and returns that terminal's address. A preview
     * terminal that is still live is returned as it is, so one task never
     * runs two dev servers.
     *
     * The terminal carries no fleet label, so the roster never reads it as an
     * agent of the task.
     */
    readonly preview: (worker: Worker, command: string) => Effect.Effect<string, FleetError>;

    /** Brings a task's workspace to the front so a human can take over. */
    readonly focus: (worker: Worker) => Effect.Effect<void, FleetError>;

    /** Stops one live role while leaving its workspace and worktree available. */
    readonly stop: (worker: Worker, role: AgentRole) => Effect.Effect<void, FleetError>;

    /**
     * Ends a task's agents and removes the worktree when foreman made one.
     * The branch survives either way.
     *
     * The worktree is found from git's record of the task's branch, not from
     * the agents, so a worktree whose agents already ended is removed rather
     * than orphaned. A worker over the operator's own checkout has no
     * worktree, and that directory is never removed.
     */
    readonly close: (options: CloseOptions) => Effect.Effect<void, FleetError>;

    /**
     * Notifies the operator.
     *
     * Two rules decide what may come through here. Without them, the fleet
     * dings on every poll.
     *
     * **Only what foreman itself did.** An agent that blocked, stopped or
     * handed off is the multiplexer's event: it sees it first and already alerts.
     * Foreman announces what the multiplexer cannot know — a branch that landed, a task
     * that climbed onto the operator, an undone merge.
     *
     * **Only on a transition, never on a condition.** A tick reads the whole
     * world back, so a notification on a path that writes nothing fires again
     * on the next tick, and every tick after. If the code reaching this call
     * has not written to the task store or the checkout, it must not call it.
     */
    readonly notify: (title: string, body: string) => Effect.Effect<void, FleetError>;

    /**
     * Whether this process runs inside one of the fleet's agent terminals.
     *
     * A worker may file tasks but never start an agent: dispatching is the
     * operator's, so `foreman dispatch` and `foreman add --dispatch` refuse a
     * worker. A process outside the multiplexer is the operator's. A terminal
     * the multiplexer cannot describe is an error, never the operator, so a
     * worker is not let through by a question nobody answered.
     */
    readonly inWorker: Effect.Effect<boolean, FleetError>;
  }
>()("Fleet") {}

export interface OpenOptions {
  readonly task: string;
  readonly repository: string;
  readonly branch: string;
  readonly directory: string;

  /**
   * The branch the task's route lands on, which a new branch is cut from and
   * records as its upstream; absent when it lands on the branch the checkout has
   * out, which the new branch then records.
   */
  readonly onto: string | undefined;
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

  /** The rung's thinking level; the adapter maps it to the harness's flag. */
  readonly thinking?: string | undefined;
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
 * The two are `author` and `review`; a review is a second role rather than the
 * author again because the reviewer reads what the author produced, and calling
 * it an author would have it refuse the pane the author is still sitting in.
 */
export const AgentRole = Schema.Literals(["author", "review"]);
export type AgentRole = Schema.Schema.Type<typeof AgentRole>;

/**
 * A task's workspace, as the multiplexer currently sees it.
 *
 * Carries no role. The task store records author and active-reviewer labels;
 * storing the same fact here would let the two disagree after a restart.
 */
export interface Worker {
  readonly task: string;
  readonly directory: string;

  /**
   * Set when the multiplexer made a worktree for this workspace, absent when
   * the workspace is attached to a checkout that was already there.
   *
   * Read back from the multiplexer every tick rather than remembered, because
   * it decides whether teardown may delete the directory, and a value from
   * foreman's own memory can name a directory that holds a person's work.
   */
  readonly worktree: string | undefined;

  /**
   * The checkout this workspace's worktree belongs to — the main repository,
   * not the linked directory — and absent when the workspace has no worktree
   * at all.
   *
   * This is the only ownership the world records that survives the task being
   * deleted. Scoping by the task's project instead means asking the store
   * about every workspace on the machine before knowing whether any of them is
   * this dispatcher's, and leaves a workspace whose task is gone unclassifiable.
   */
  readonly repository: string | undefined;
  readonly state: WorkerState;

  /**
   * When `state` began, in epoch milliseconds, as the agent's harness reported
   * it: for a settled agent, when its last turn ended. Absent when the harness
   * reports no time or nothing runs.
   */
  readonly since: number | undefined;

  /**
   * What the multiplexer sees in the pane each role runs in, for the roles
   * that have one.
   *
   * A worker carries every role at once so a task reads as its author while it
   * is written and as its reviewer once it is handed off; the caller picks the
   * one it is asking about — `workerFor` takes what the task store says is
   * active. No pane address is kept here: a
   * dispatch is refused from the pane list itself, and dismissing the author
   * means closing the workspace, which needs only the workspace id.
   */
  readonly roles: ReadonlyMap<AgentRole, Pane>;
}

/** One role's pane: what its agent is doing, and since when (see `Worker.since`). */
export interface Pane {
  readonly state: WorkerState;
  readonly since: number | undefined;
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
}) {
  override get message() {
    return `${this.operation}: ${this.detail}`;
  }
}

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

/**
 * Runs `awaitTurn` until `working` reads false. The reading is taken after
 * every return, not trusted from the wait: a check-in or a terminal that went
 * away both return the wait early, and only the roster says the work is done.
 */
export const untilNotWorking = <E>(
  working: Effect.Effect<boolean, E>,
  awaitTurn: Effect.Effect<void, E>,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    while (yield* working) yield* awaitTurn;
  });
