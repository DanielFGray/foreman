import { Command, CommandExecutor } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Data, Effect, Layer, Schema, Stream } from "effect";
import {
  AgentRole,
  type AttachOptions,
  type CloseOptions,
  Fleet,
  FleetError,
  labelFor,
  type OpenOptions,
  type SpawnOptions,
  taskOf,
  type Worker,
  type WorkerState,
} from "./fleet.ts";

/**
 * Fleet over the herdr CLI.
 *
 * Every herdr response is a JSON envelope on stdout, so the adapter parses
 * rather than scrapes. Identifiers are always read back from the responses that
 * create them; herdr does not promise they are predictable.
 */
export const HerdrFleet = Layer.effect(
  Fleet,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;

    /**
     * Runs herdr and reports what it actually did.
     *
     * Exit status is the point. A rejected argument prints usage to stderr and
     * leaves stdout empty; a refused operation prints an error envelope and
     * exits non-zero. Reading stdout alone turns both into "success with
     * nothing to say", which is how foreman came to log a dispatch for an agent
     * that was never prompted, claim the task, and leave the pane on a splash
     * screen for an hour.
     */
    const exec = (operation: string, args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* executor.start(
            Command.make("herdr", ...args).pipe(Command.stdout("pipe"), Command.stderr("pipe")),
          );
          const [exitCode, stdout, stderr] = yield* Effect.all(
            [
              process.exitCode,
              Stream.decodeText(process.stdout).pipe(Stream.mkString),
              Stream.decodeText(process.stderr).pipe(Stream.mkString),
            ],
            { concurrency: 3 },
          );
          return { exitCode: Number(exitCode), stdout, stderr };
        }),
      ).pipe(Effect.mapError((cause) => new FleetError({ operation, detail: String(cause) })));

    const herdr = (operation: string, ...args: Array<string>) =>
      exec(operation, args).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(new FleetError({ operation, detail: failureOf(result) })),
        ),
      );

    const herdrJson = <A, I>(
      schema: Schema.Schema<A, I>,
      operation: string,
      ...args: Array<string>
    ) =>
      herdr(operation, ...args).pipe(
        Effect.flatMap((out) =>
          Schema.decodeUnknown(Schema.parseJson(schema))(out).pipe(
            Effect.mapError((cause) => new FleetError({ operation, detail: String(cause) })),
          ),
        ),
      );

    /**
     * Submits a prompt and returns once the agent is working on it.
     *
     * `agent start` promises a pane "ready for input" and returns about three
     * seconds after launch, but opencode does not accept input for about nine.
     * A prompt sent into that gap is dropped — no text reaches the input box —
     * and `agent prompt --wait` gives up after a fixed five seconds it offers
     * no way to extend, so the first attempt fails every time rather than
     * occasionally. herdr is a third-party tool here; foreman's adapter is
     * where its behaviour is accounted for.
     *
     * Retrying is safe precisely because the prompt is dropped whole: there is
     * no half-submitted text to duplicate. `--until working` is what makes the
     * outcome real — it distinguishes an agent that took the prompt from one
     * sitting idle on a splash screen, which the roster would otherwise read as
     * a settled worker and escalate.
     */
    const prompt = (agent: string, text: string) =>
      exec("spawn", ["agent", "prompt", agent, text, "--wait", "--until", "working"]).pipe(
        Effect.flatMap((result): Effect.Effect<void, FleetError | Stalled> => {
          if (result.exitCode === 0) return Effect.void;
          if (errorOf(result)?.code === STALLED) return Effect.fail(new Stalled());
          return Effect.fail(new FleetError({ operation: "spawn", detail: failureOf(result) }));
        }),
        // Each attempt already spends herdr's five-second wait, so this paces
        // itself; it covers roughly half a minute of a slow-starting agent.
        Effect.retry({ while: (error) => error._tag === "Stalled", times: 5 }),
        Effect.catchTag("Stalled", () =>
          Effect.fail(
            new FleetError({
              operation: "spawn",
              detail: `${agent} never accepted a prompt; it is running but not listening`,
            }),
          ),
        ),
      );

    /**
     * Foreman's workspaces, joined to a pane inside each one.
     *
     * Two calls rather than one per workspace: herdr lists every pane at once
     * with the workspace it belongs to, and a dispatcher that polls every
     * twenty seconds should not issue a call per worker to do it.
     */
    const roster = Effect.all([
      herdrJson(WorkspaceList, "roster", "workspace", "list"),
      herdrJson(PaneList, "roster", "pane", "list"),
    ]).pipe(
      Effect.map(([workspaces, panes]) =>
        workspaces.result.workspaces.flatMap((workspace) => {
          const task = taskOf(workspace.label);
          if (!task) return [];
          const workspacePanes = panes.result.panes.filter(
            (candidate) => candidate.workspace_id === workspace.workspace_id,
          );
          const pane = paneFor(workspacePanes);
          if (!pane) return [];
          return [
            {
              task,
              workspace: workspace.workspace_id,
              pane: pane.pane_id,
              directory: workspace.worktree?.checkout_path ?? pane.cwd,
              // A linked worktree is one foreman made; a workspace attached to
              // a checkout that was already there reports a worktree that is
              // not linked. The field says which directory teardown may
              // delete, so it keys on that distinction rather than on the mere
              // presence of a checkout path.
              worktree: workspace.worktree?.is_linked_worktree
                ? workspace.worktree.checkout_path
                : undefined,
              // Workspace status is an attention aggregate where an unseen old
              // done pane outranks current work. Dispatch needs operational
              // state, so aggregate the panes with live work first instead.
              state: workerStateOf(workspacePanes.map((candidate) => candidate.agent_status)),
              roles: rolesOf(workspacePanes),
            } satisfies Worker,
          ];
        }),
      ),
    );

    /** Every worktree git has registered in a project's checkout. */
    const worktreesFor = (repository: string) =>
      herdrJson(WorktreeList, "open", "worktree", "list", "--cwd", repository).pipe(
        Effect.map((list) => list.result.worktrees),
      );

    /**
     * Attaches a fresh workspace to a worktree git already has, returning it
     * like a created one. This is the durable half of open and close: a
     * worktree survives its workspace, so reaching the work does not.
     */
    const adoptWorktree = (options: {
      readonly task: string;
      readonly repository: string;
      readonly branch: string;
    }) =>
      herdrJson(
        WorktreeResolved,
        "open",
        "worktree",
        "open",
        "--cwd",
        options.repository,
        "--branch",
        options.branch,
        "--label",
        labelFor(options.task),
        "--no-focus",
      ).pipe(
        Effect.map(
          (opened) =>
            ({
              task: options.task,
              workspace: opened.result.workspace.workspace_id,
              pane: opened.result.root_pane.pane_id,
              directory: opened.result.worktree.path,
              worktree: opened.result.worktree.path,
              state: "gone",
              roles: new Map(),
            }) satisfies Worker,
        ),
      );

    /** Creates the worktree and the workspace over it in one call. */
    const createWorktree = (options: OpenOptions) =>
      herdrJson(
        WorktreeResolved,
        "open",
        "worktree",
        "create",
        "--cwd",
        options.repository,
        "--branch",
        options.branch,
        "--base",
        "HEAD",
        "--path",
        options.directory,
        "--label",
        labelFor(options.task),
        "--no-focus",
      ).pipe(
        Effect.map(
          (created) =>
            ({
              task: options.task,
              workspace: created.result.workspace.workspace_id,
              pane: created.result.root_pane.pane_id,
              directory: created.result.worktree.path,
              worktree: created.result.worktree.path,
              state: "gone",
              roles: new Map(),
            }) satisfies Worker,
        ),
      );

    /** Removes a worktree whose workspace herdr has already dropped. */
    const removeWorktreeByAdoption = (repository: string, task: string) =>
      adoptWorktree({ task, repository, branch: labelFor(task) }).pipe(
        Effect.flatMap((adopted) =>
          herdr("close", "worktree", "remove", "--workspace", adopted.workspace, "--force"),
        ),
      );

    return {
      roster,

      open: (options: OpenOptions) =>
        Effect.gen(function* () {
          const resolution = resolveOpen(
            yield* roster,
            yield* worktreesFor(options.repository),
            options,
          );
          switch (resolution.kind) {
            case "workspace":
              // Adopting an existing workspace is what makes a restart safe:
              // the label is the identity, so foreman recognises work it
              // started in a previous life instead of opening a second
              // workspace beside it.
              return resolution.worker;

            case "worktree":
              // The workspace is gone — closing its last pane closed it — but
              // the worktree git still has is where the interrupted agent's
              // edits live. Adopting it is the difference between continuing
              // that work and `worktree create` colliding with a directory
              // that already exists forever.
              yield* Effect.logInfo(
                `adopting ${options.branch} at ${resolution.worktree.path}: its workspace closed but the worktree survives`,
              );
              return yield* adoptWorktree(options);

            case "create":
              return yield* createWorktree(options);
          }
        }),

      attach: (options: AttachOptions) =>
        Effect.gen(function* () {
          const existing = (yield* roster).find((worker) => worker.task === options.task);
          if (existing) return existing;

          const created = yield* herdrJson(
            WorkspaceCreated,
            "attach",
            "workspace",
            "create",
            "--cwd",
            options.repository,
            "--label",
            labelFor(options.task),
            "--no-focus",
          );

          return {
            task: options.task,
            workspace: created.result.workspace.workspace_id,
            pane: created.result.root_pane.pane_id,
            directory: options.repository,
            worktree: undefined,
            state: "gone",
            roles: new Map(),
          } satisfies Worker;
        }),

      spawn: (worker: Worker, options: SpawnOptions) =>
        Effect.gen(function* () {
          const role = paneLabelFor(options.role);

          // One *running* agent per role per workspace, checked against the
          // multiplexer rather than against anything foreman remembers. Two
          // agents working one worktree edit over each other, so a role still
          // working or blocked refuses the dispatch — and refusing is right,
          // because the caller hands the claim back and the slot goes to
          // somebody else.
          //
          // A settled agent is not that. It has stopped, it is editing nothing,
          // and nothing will ever end it on its own: herdr cannot stop an agent
          // without closing the pane it runs in, and the paths that keep a
          // workspace across dispatches — a reviewer returning work, a vanished
          // author's edits — keep its role panes too. Reading settled as live
          // made those the permanent stall: the task returns to the queue, the
          // queue offers it back, and the same refusal repeats every poll
          // forever. Settled panes are spent, and are closed below.
          const workspacePanes = (yield* herdrJson(
            PaneList,
            "spawn",
            "pane",
            "list",
            "--workspace",
            worker.workspace,
          )).result.panes;
          const held = workspacePanes.filter((pane) => pane.label === role);
          const live = held.find((pane) => stillRunning(workerStateOf([pane.agent_status])));
          if (live) {
            return yield* new FleetError({
              operation: "spawn",
              detail: `${worker.workspace} already runs a ${role} in ${live.pane_id}${live.agent_session?.value ? ` (${live.agent_session.value})` : ""}`,
            });
          }

          // Placement is read off the workspace rather than declared per role.
          // The first agent takes the workspace's own pane, because splitting
          // one for it used to leave a blank shell beside every worker; the
          // next role splits off it, and its pane lands beside the output it
          // was sent to read — which is the layout both a review and a plan's
          // tasking stage are for.
          //
          // A pane that already carries this role is never reused, even by the
          // same role: the settled agent inside it can only be ended by closing
          // it, so the replacement has to be split before the spent one goes.
          // Splitting first is also what keeps the workspace alive when the
          // spent pane is its only one.
          const own = workspacePanes.find((pane) => pane.pane_id === worker.pane);
          const split =
            own?.label !== undefined
              ? yield* herdrJson(
                  PaneSplit,
                  "spawn",
                  "pane",
                  "split",
                  "--pane",
                  worker.pane,
                  // Required by herdr, and side by side is the useful one: a
                  // reviewer reads the diff next to the author's output rather
                  // than under it.
                  "--direction",
                  "right",
                  "--cwd",
                  worker.directory,
                  "--no-focus",
                )
              : undefined;
          const pane = split?.result.pane.pane_id ?? worker.pane;
          const agent = agentNameFor(pane);

          // A failure takes back the pane this dispatch made, and nothing else.
          // The first role in a workspace takes the workspace's own pane, which
          // pre-dates the dispatch: closing it would close the workspace and
          // orphan its worktree. So that failure is left as residue for the
          // operator, exactly like a spawn that failed before any pane existed.
          return yield* Effect.gen(function* () {
            yield* herdr("spawn", "pane", "rename", pane, role);

            // The spent panes go, rather than losing their label. None of them
            // is running — a working or blocked one refused the dispatch above
            // — and closing the pane is the only way to end the settled agent
            // still sitting in it. Clearing the label instead left a pane
            // nothing could name, which is how an agent stayed alive in a
            // workspace foreman believed was empty.
            yield* Effect.forEach(
              held.filter((spent) => spent.pane_id !== pane),
              (spent) => herdr("spawn", "pane", "close", spent.pane_id).pipe(Effect.ignore),
              { discard: true },
            );
            const started = yield* herdrJson(
              AgentEnvelope,
              "spawn",
              "agent",
              "start",
              agent,
              "--kind",
              options.kind,
              "--pane",
              pane,
              // Everything after `--` is herdr's passthrough to the agent's own
              // command line. `--model` is the flag opencode and claude both
              // take; a harness that does not know it must be configured as a
              // rung with no model.
              ...(options.model ? ["--", "--model", options.model] : []),
            );

            yield* prompt(agent, options.prompt);

            // Integrations can add metadata tokens after the first prompt. The
            // task still started if this optional observation is unavailable.
            const model = yield* herdrJson(
              AgentEnvelope,
              "spawn metadata",
              "agent",
              "get",
              agent,
            ).pipe(
              Effect.map((info) => info.result.agent.tokens?.["model"]),
              Effect.catchAll((error) =>
                Effect.logWarning(`agent metadata unavailable for ${agent}: ${error}`).pipe(
                  Effect.as(started.result.agent.tokens?.["model"]),
                ),
              ),
            );

            return { kind: options.kind, model };
          }).pipe(
            Effect.onError(() =>
              split ? herdr("spawn", "pane", "close", pane).pipe(Effect.ignore) : Effect.void,
            ),
          );
        }),

      stop: (worker: Worker, role: AgentRole) =>
        Effect.gen(function* () {
          const panes = (yield* herdrJson(
            PaneList,
            "stop role",
            "pane",
            "list",
            "--workspace",
            worker.workspace,
          )).result.panes;
          // Closing the last pane evaporates the workspace, and that is the
          // intended end: the worktree and its uncommitted edits outlive it,
          // and whatever runs next re-adopts them through `open`. Keeping the
          // view alive with an unlabelled shell leaves a blank pane and a
          // workspace the roster reads as residue.
          const held = panes.filter((pane) => pane.label === paneLabelFor(role));

          yield* Effect.forEach(held, (pane) => herdr("stop role", "pane", "close", pane.pane_id), {
            discard: true,
          });
        }).pipe(Effect.asVoid),

      focus: (worker: Worker) =>
        herdr("focus", "workspace", "focus", worker.workspace).pipe(Effect.asVoid),

      close: (options: CloseOptions) =>
        Effect.gen(function* () {
          const workers = yield* roster;
          const worker = workers.find((candidate) => candidate.task === options.task);
          const worktrees =
            worker !== undefined || options.repository === undefined
              ? []
              : yield* worktreesFor(options.repository);
          const resolution = resolveClose(workers, worktrees, options.task);
          switch (resolution.kind) {
            case "workspace":
              // Attached to a checkout that was already there, which belongs to
              // the operator: only the workspace over it closes.
              yield* herdr("close", "workspace", "close", resolution.worker.workspace);
              return;

            case "worktree":
              // The worktree is the durable thing, and the branch survives
              // either way. A live workspace is removed with it; one herdr has
              // already dropped — its last pane closed by hand — leaves a
              // worktree that must be adopted to be removed rather than
              // orphaned in place.
              if (resolution.worker) {
                yield* herdr(
                  "close",
                  "worktree",
                  "remove",
                  "--workspace",
                  resolution.worker.workspace,
                  "--force",
                ).pipe(
                  Effect.orElse(() =>
                    options.repository
                      ? removeWorktreeByAdoption(options.repository, options.task)
                      : Effect.void,
                  ),
                );
              } else if (options.repository) {
                yield* removeWorktreeByAdoption(options.repository, options.task);
              }
              return;

            case "nothing":
              return;
          }
        }).pipe(Effect.asVoid, Effect.ignore),

      notify: (title: string, body: string) =>
        Effect.gen(function* () {
          const workspaces = yield* herdrJson(WorkspaceList, "notify", "workspace", "list");
          const focused = workspaces.result.workspaces.find((workspace) => workspace.focused);
          if (focused && focused.workspace_id === ownWorkspace()) return;
          yield* herdr("notify", "notification", "show", title, "--body", body, "--sound", "done");
        }),
    };
  }),
).pipe(Layer.provide(BunContext.layer));

/** herdr dropped the prompt because the agent was not listening yet. */
class Stalled extends Data.TaggedError("Stalled") {}

const STALLED = "agent_prompt_stalled";

interface Output {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * What herdr said went wrong, preferred over the exit number.
 *
 * A refused operation answers with an error envelope, a rejected argument
 * prints usage, and an operator reading the log needs whichever herdr chose to
 * give.
 */
const failureOf = (result: Output): string => {
  const error = errorOf(result);
  if (error) return error.message === "" ? error.code : `${error.code}: ${error.message}`;
  const stderr = result.stderr.trim();
  return stderr === "" ? `exit ${result.exitCode}` : stderr;
};

/**
 * herdr's error envelope, from whichever stream carried it.
 *
 * Results come back on stdout and failures on stderr, so a reader that watches
 * only one of them sees the envelope as unparseable text — which is how a
 * dropped prompt read as an unrecognised failure instead of the retryable one
 * it is.
 */
const errorOf = (result: Output): { code: string; message: string } | undefined =>
  envelopeError(result.stdout) ?? envelopeError(result.stderr);

const envelopeError = (text: string): { code: string; message: string } | undefined => {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const error = parsed.error;
    if (!error || typeof error.code !== "string") return undefined;
    return { code: error.code, message: typeof error.message === "string" ? error.message : "" };
  } catch {
    // Not an envelope. herdr printed usage or something else, and `failureOf`
    // falls back to the raw text rather than pretending this parsed.
    return undefined;
  }
};

/**
 * The workspace foreman itself runs in, read from the pane identity herdr
 * injects into its environment. Panes are named `<workspace>:<pane>`.
 */
const ownWorkspace = (): string => (process.env["HERDR_PANE_ID"] ?? "").split(":")[0] ?? "";

/** herdr agent names exclude `/` and must be unique while old panes remain. */
export const agentNameFor = (pane: string): string =>
  `f-${pane
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(-24)}`;

/**
 * A pane label naming the role its agent runs, and the role read back off it.
 *
 * Namespaced so a pane a person labelled is never mistaken for foreman's, and
 * parsed rather than matched against a table: the roles are whatever the port
 * declares, and a label outside that set belongs to somebody else.
 */
const paneLabelFor = (role: AgentRole): string => `foreman-${role}`;

const roleOf = (label: string | undefined): AgentRole | undefined => {
  if (!label?.startsWith("foreman-")) return undefined;
  const role = label.slice("foreman-".length);
  return Schema.is(AgentRole)(role) ? role : undefined;
};

/**
 * herdr distinguishes idle from done by whether the operator has seen the tab.
 * That difference matters to a person reading the sidebar and not at all to the
 * dispatcher, which re-reads the task to find out what the agent accomplished.
 *
 * `unknown` means no agent is running in the workspace. That covers an agent
 * which exited cleanly and a pane a human closed mid-task, and herdr cannot
 * tell them apart — so neither does foreman. What the agent achieved is read
 * from the task store, and if the task store says nothing happened, the
 * question goes to the operator rather than to a guess.
 */
/**
 * Whether an agent in this state must finish before its role is dispatched
 * again.
 *
 * Only work in progress can collide. A settled agent has stopped and is
 * editing nothing, and nothing will end it on its own — so treating it as a
 * reason to refuse is a stall with no exit, not caution.
 */
export const stillRunning = (state: WorkerState): boolean =>
  state === "working" || state === "blocked";

export const workerStateOf = (statuses: ReadonlyArray<string>): WorkerState => {
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.some((status) => !["idle", "done", "unknown"].includes(status))) return "working";
  if (statuses.some((status) => status === "idle" || status === "done")) return "settled";
  return "gone";
};

/**
 * Which record a task's open resolves to: a workspace carrying its label, else
 * a worktree git still has for its branch, else neither.
 *
 * The order is the point. A workspace is the live view and dies with its last
 * pane, while the worktree and branch are durable — so the workspace is tried
 * first for a restart's sake, and the worktree is what keeps a task whose
 * workspace a keypress destroyed reachable instead of colliding with a
 * `worktree create` on a directory that already exists.
 */
export type OpenResolution =
  | { readonly kind: "workspace"; readonly worker: Worker }
  | { readonly kind: "worktree"; readonly worktree: WorktreeRecord }
  | { readonly kind: "create" };

export const resolveOpen = (
  workers: ReadonlyArray<Worker>,
  worktrees: ReadonlyArray<WorktreeRecord>,
  options: OpenOptions,
): OpenResolution => {
  const worker = workers.find((candidate) => candidate.task === options.task);
  if (worker) return { kind: "workspace", worker };
  const worktree = worktrees.find(
    (candidate) => candidate.branch === options.branch && !candidate.is_prunable,
  );
  return worktree ? { kind: "worktree", worktree } : { kind: "create" };
};

/**
 * Which teardown a task's close resolves to, the same order as open.
 *
 * A workspace over a checkout that was already there is only closed; a worktree
 * foreman made is removed whether or not its workspace survives — when it does,
 * the remove takes both, and when it does not the worktree is adopted first so
 * it can be removed at all rather than orphaned in place.
 */
export type CloseResolution =
  | { readonly kind: "workspace"; readonly worker: Worker }
  | { readonly kind: "worktree"; readonly worker: Worker | undefined }
  | { readonly kind: "nothing" };

export const resolveClose = (
  workers: ReadonlyArray<Worker>,
  worktrees: ReadonlyArray<WorktreeRecord>,
  task: string,
): CloseResolution => {
  const worker = workers.find((candidate) => candidate.task === task);
  if (worker) {
    return worker.worktree === undefined
      ? { kind: "workspace", worker }
      : { kind: "worktree", worker };
  }
  return worktrees.some(
    (candidate) => candidate.branch === labelFor(task) && !candidate.is_prunable,
  )
    ? { kind: "worktree", worker: undefined }
    : { kind: "nothing" };
};

const Worktree = Schema.Struct({
  checkout_path: Schema.String,
  is_linked_worktree: Schema.Boolean,
});

const Workspace = Schema.Struct({
  workspace_id: Schema.String,
  label: Schema.String,
  agent_status: Schema.String,
  focused: Schema.Boolean,
  worktree: Schema.optional(Worktree),
});

const WorkspaceList = Schema.Struct({
  result: Schema.Struct({ workspaces: Schema.Array(Workspace) }),
});

const Pane = Schema.Struct({
  pane_id: Schema.String,
  workspace_id: Schema.String,
  cwd: Schema.String,
  label: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  agent_status: Schema.String,
  // herdr detects the harness's own session id and reports it here. Optional
  // because a plain shell has none, and because a pane whose agent has died
  // may not keep one — which is why foreman must not depend on it alone.
  agent_session: Schema.optional(Schema.Struct({ value: Schema.optional(Schema.String) })),
});

type PaneRecord = Schema.Schema.Type<typeof Pane>;

/**
 * The workspace's own pane: what the author takes and a reviewer splits from.
 *
 * Panes come back root-first, so the first is the workspace's own. The
 * preference exists for the one pane that is not yet the author's — a fresh
 * workspace's shell — and the fallback keeps the author's pane once it has
 * taken the root and labelled it, which is what a restart re-reads.
 */
export const paneFor = (panes: ReadonlyArray<PaneRecord>): PaneRecord | undefined =>
  panes.find((candidate) => candidate.agent === undefined && candidate.label === undefined) ??
  panes[0];

/**
 * Which role each of a workspace's labelled panes is running, and how that
 * pane is doing.
 *
 * The label is the record. herdr keeps it across dispatches, so a role a
 * workspace has never run is simply absent, and a role whose agent died is
 * present and `gone` — which is the difference between a task that was never
 * reviewed and one whose reviewer vanished.
 */
const rolesOf = (panes: ReadonlyArray<PaneRecord>): ReadonlyMap<AgentRole, WorkerState> =>
  new Map(
    panes.flatMap((pane) => {
      const role = roleOf(pane.label);
      return role ? [[role, workerStateOf([pane.agent_status])] as const] : [];
    }),
  );

const PaneList = Schema.Struct({
  result: Schema.Struct({ panes: Schema.Array(Pane) }),
});

const PaneSplit = Schema.Struct({
  result: Schema.Struct({ pane: Schema.Struct({ pane_id: Schema.String }) }),
});

const AgentEnvelope = Schema.Struct({
  result: Schema.Struct({
    agent: Schema.Struct({
      tokens: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
    }),
  }),
});

const WorkspaceCreated = Schema.Struct({
  result: Schema.Struct({
    workspace: Schema.Struct({ workspace_id: Schema.String }),
    root_pane: Schema.Struct({ pane_id: Schema.String }),
  }),
});

/** A workspace over a worktree, whether the worktree was just made or adopted. */
const WorktreeResolved = Schema.Struct({
  result: Schema.Struct({
    workspace: Schema.Struct({ workspace_id: Schema.String }),
    root_pane: Schema.Struct({ pane_id: Schema.String }),
    worktree: Schema.Struct({ path: Schema.String }),
  }),
});

/**
 * One worktree git has registered, as herdr reports it. `is_prunable` excludes
 * a registration whose directory is gone — such a worktree has nothing to
 * adopt and nothing to remove.
 */
const WorktreeRecord = Schema.Struct({
  branch: Schema.optional(Schema.String),
  path: Schema.String,
  is_prunable: Schema.Boolean,
});
export type WorktreeRecord = Schema.Schema.Type<typeof WorktreeRecord>;

const WorktreeList = Schema.Struct({
  result: Schema.Struct({ worktrees: Schema.Array(WorktreeRecord) }),
});
