import { Command, CommandExecutor } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Data, Effect, Layer, Schema, Stream } from "effect";
import {
  type AttachOptions,
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
          const author = workspacePanes.find((candidate) => candidate.label === AUTHOR_PANE);
          const review = workspacePanes.find((candidate) => candidate.label === REVIEW_PANE);
          return [
            {
              task,
              workspace: workspace.workspace_id,
              pane: pane.pane_id,
              directory: workspace.worktree?.checkout_path ?? pane.cwd,
              worktree: workspace.worktree?.checkout_path,
              // Workspace status is an attention aggregate where an unseen old
              // done pane outranks current work. Dispatch needs operational
              // state, so aggregate the panes with live work first instead.
              state: workerStateOf(workspacePanes.map((candidate) => candidate.agent_status)),
              author: roleStateOf(author),
              review: roleStateOf(review),
            } satisfies Worker,
          ];
        }),
      ),
    );

    return {
      roster,

      open: (options: OpenOptions) =>
        Effect.gen(function* () {
          // Adopting an existing workspace is what makes a restart safe: the
          // label is the identity, so foreman recognises work it started in a
          // previous life instead of opening a second workspace beside it.
          const existing = (yield* roster).find((worker) => worker.task === options.task);
          if (existing) return existing;

          const created = yield* herdrJson(
            WorktreeCreated,
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
          );

          return {
            task: options.task,
            workspace: created.result.workspace.workspace_id,
            pane: created.result.root_pane.pane_id,
            directory: created.result.worktree.path,
            worktree: created.result.worktree.path,
            state: "gone",
            author: undefined,
            review: undefined,
          } satisfies Worker;
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
            author: undefined,
            review: undefined,
          } satisfies Worker;
        }),

      spawn: (worker: Worker, options: SpawnOptions) =>
        Effect.gen(function* () {
          const role = options.role === "author" ? AUTHOR_PANE : REVIEW_PANE;

          // One agent per role per workspace, checked against the multiplexer
          // rather than against anything foreman remembers. An agent that is
          // still alive here is one foreman lost track of — killed and restored
          // by herdr, or idle after work foreman read as abandoned. Letting a
          // second one in puts two agents in one worktree, both editing.
          //
          // A refusal is a failure of this dispatch, which is exactly right:
          // the caller already hands the claim back on one, so the task returns
          // to the queue and the slot goes to somebody else.
          const held = (yield* herdrJson(PaneList, "spawn", "pane", "list")).result.panes.filter(
            (pane) => pane.workspace_id === worker.workspace && pane.label === role,
          );
          const live = held.find((pane) => workerStateOf([pane.agent_status]) !== "gone");
          if (live) {
            return yield* new FleetError({
              operation: "spawn",
              detail: `${worker.workspace} already runs a ${role} in ${live.pane_id}${live.agent_session?.value ? ` (${live.agent_session.value})` : ""}`,
            });
          }

          // The author takes the workspace's own pane; only a reviewer splits.
          // Splitting a second pane for the author used to leave a blank shell
          // beside every worker, so the author spawns in place in the root
          // pane, and a reviewer splits off it — the new pane lands beside the
          // author's output, which is the layout a review is for.
          const split =
            options.role === "review"
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

          // A review failure takes its own split back down; an author failure
          // has nothing to take down, because the author's pane is the
          // workspace's own and pre-dates this dispatch. Closing it would close
          // the workspace and orphan its worktree, so the failed dispatch is
          // left as residue for the operator, exactly like a spawn that failed
          // before any pane existed.
          return yield* Effect.gen(function* () {
            yield* herdr("spawn", "pane", "rename", pane, role);

            // The spent panes go, rather than losing their label. Every one
            // here is dead — a live one refused the dispatch above. Clearing
            // the label instead left a pane nothing could name, which is how an
            // agent stayed alive in a workspace foreman believed was empty. The
            // author's own pane is the exception: it carries the role label
            // across dispatches and is being reused, not spent.
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
              options.role === "review"
                ? herdr("spawn", "pane", "close", pane).pipe(Effect.ignore)
                : Effect.void,
            ),
          );
        }),

      focus: (worker: Worker) =>
        herdr("focus", "workspace", "focus", worker.workspace).pipe(Effect.asVoid),

      close: (worker: Worker) =>
        // Two different teardowns, chosen by who owns the directory. A worktree
        // foreman created is removed with it; a checkout that was already there
        // belongs to the operator, and only the workspace over it is closed.
        // `workspace close` alone would leave the worktree on disk and
        // registered with git, and `worktree remove` refuses on an attached
        // workspace and would leave the workspace open.
        //
        // The branch is deliberately left behind. If the work merged the branch
        // is redundant and harmless; if it was rejected the branch is the only
        // copy of what the agent did.
        (worker.worktree === undefined
          ? herdr("close", "workspace", "close", worker.workspace)
          : herdr("close", "worktree", "remove", "--workspace", worker.workspace, "--force")
        ).pipe(Effect.asVoid, Effect.ignore),

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

const AUTHOR_PANE = "foreman-author";
const REVIEW_PANE = "foreman-review";

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
export const workerStateOf = (statuses: ReadonlyArray<string>): WorkerState => {
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.some((status) => !["idle", "done", "unknown"].includes(status))) return "working";
  if (statuses.some((status) => status === "idle" || status === "done")) return "settled";
  return "gone";
};

const Worktree = Schema.Struct({ checkout_path: Schema.String });

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
  panes.find(
    (candidate) => candidate.agent === undefined && candidate.label === undefined,
  ) ?? panes[0];

const roleStateOf = (pane: PaneRecord | undefined): WorkerState | undefined =>
  pane ? workerStateOf([pane.agent_status]) : undefined;

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

const WorktreeCreated = Schema.Struct({
  result: Schema.Struct({
    workspace: Schema.Struct({ workspace_id: Schema.String }),
    root_pane: Schema.Struct({ pane_id: Schema.String }),
    worktree: Schema.Struct({ path: Schema.String }),
  }),
});
