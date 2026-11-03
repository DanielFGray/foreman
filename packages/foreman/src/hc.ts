import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Schema as S, Stream } from "effect";
import {
  type AgentRole,
  AgentRole as AgentRoleSchema,
  type AttachOptions,
  type CloseOptions,
  Fleet,
  FleetError,
  type OpenOptions,
  type SpawnOptions,
  type Pane,
  type Worker,
  type WorkerState,
  labelFor,
} from "./fleet.ts";
import { harnessLaunch } from "./harness.ts";
import { Repository, type Worktree } from "./repository.ts";

/**
 * The fleet over hc (herdr-core) terminals, shown by herdr-app.
 *
 * A task's agents are terminals labelled with the task and the role each one
 * runs, so the roster is read back from hc every tick and foreman remembers
 * nothing. The worktree is git's: `Repository` makes and removes it, and a
 * terminal is only ever started inside one that already exists.
 *
 * herdr-app places a terminal by its `herdr.space` and `herdr.tab` labels.
 * Every agent of a task shares one tab, so a reviewer opens beside the author
 * it was sent to read.
 */
export const HcFleet = hcFleetOver().pipe(Layer.provide([Repository.Default, BunServices.layer]));

/**
 * `HcFleet` without its dependencies, so a test can supply a scripted process
 * spawner and repository in place of the real ones.
 */
export function hcFleetOver() {
  return Layer.effect(
    Fleet,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const repository = yield* Repository;

      /**
       * Runs one program and reports its exit code and both streams.
       *
       * Exit status is the point: a refusal prints to stderr and exits non-zero,
       * and reading stdout alone turns it into "success with nothing to say".
       */
      const exec = (operation: string, program: string, args: ReadonlyArray<string>, input = "") =>
        Effect.scoped(
          Effect.gen(function* () {
            const process = yield* spawner.spawn(
              ChildProcess.make(program, args, {
                stdin: Stream.make(input).pipe(Stream.encodeText),
              }),
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

      /**
       * One call to hc's API, through `hc connect`.
       *
       * The API rather than the CLI because `hc ls` leaves out the labels and
       * status a roster is built from, and the API lists them in one call.
       */
      const call = <A, I>(
        schema: S.Codec<A, I>,
        operation: string,
        method: string,
        params: Record<string, unknown>,
      ) =>
        exec(
          operation,
          "hc",
          ["connect"],
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`,
        ).pipe(
          Effect.flatMap((result) =>
            S.decodeEffect(S.fromJsonString(Reply))(result.stdout.trim()).pipe(
              Effect.mapError(
                () =>
                  new FleetError({
                    operation,
                    detail: result.stderr.trim() || `hc connect exited ${result.exitCode}`,
                  }),
              ),
            ),
          ),
          Effect.flatMap((reply) =>
            reply.error
              ? Effect.fail(
                  new FleetError({
                    operation,
                    detail: `${method}: ${reply.error.message}${reply.error.data?.kind ? ` (${reply.error.data.kind})` : ""}`,
                  }),
                )
              : S.decodeUnknownEffect(schema)(reply.result).pipe(
                  Effect.mapError((cause) => new FleetError({ operation, detail: String(cause) })),
                ),
          ),
        );

      /**
       * Every foreman terminal, finished ones included.
       *
       * Finished ones are kept on purpose: an agent that exited is a role that
       * is `gone`, which is a question for the operator, and only `stop` and
       * `close` remove the record.
       */
      const terminals = call(TerminalList, "roster", "terminal.list", {
        all: true,
        labels: { [FLEET]: "foreman" },
      }).pipe(Effect.map((list) => list.terminals));

      const ofTask = (task: string) =>
        terminals.pipe(
          Effect.map((all) => all.filter((terminal) => terminal.labels[TASK] === task)),
        );

      /** Ends a terminal's program if it still runs, then drops its record. */
      const end = (operation: string, terminal: Pick<Terminal, "address" | "state">) =>
        (terminal.state === "live"
          ? call(S.Unknown, operation, "terminal.kill", { terminal: terminal.address })
          : Effect.void
        ).pipe(
          Effect.andThen(call(S.Unknown, operation, "terminal.rm", { terminal: terminal.address })),
          Effect.asVoid,
        );

      /**
       * Where a task's tab goes: the space of a terminal already open on the
       * task's checkout, so the work appears in the project the operator is in.
       * With none open, the tab gets a space of its own, which herdr-app nests
       * under the project's space because its folder is a linked worktree.
       */
      const placement = (task: string, checkout: string) =>
        call(TerminalList, "spawn", "terminal.list", {}).pipe(
          Effect.map((list) => placementOf(list.terminals, task, checkout)),
          Effect.orElseSucceed(() => placementOf([], task, checkout)),
        );

      const roster = terminals.pipe(Effect.map(workersOf));

      const fail = (operation: string) => (cause: { readonly message: string }) =>
        new FleetError({ operation, detail: cause.message });

      /**
       * Blocks on one terminal's turn through `hc wait`. A check-in and a
       * terminal that went away both return normally: the caller's roster read
       * decides what they mean.
       *
       * A missing terminal is the one answer read despite a non-zero exit: hc
       * reports it as error JSON on stdout. A turn reply counts only with exit 0,
       * and stdout that is not hc's JSON is a failure with stderr as the reason.
       */
      const waitOn = (address: string) =>
        exec("wait", "hc", ["wait", address, "--json"]).pipe(
          Effect.flatMap((result) =>
            Option.match(S.decodeUnknownOption(S.fromJsonString(WaitReply))(result.stdout.trim()), {
              onNone: () =>
                Effect.fail(
                  new FleetError({
                    operation: "wait",
                    detail: result.stderr.trim() || `hc wait exited ${result.exitCode}`,
                  }),
                ),
              onSome: (reply) =>
                "error" in reply
                  ? reply.error.kind === "not_found"
                    ? Effect.void
                    : Effect.fail(
                        new FleetError({
                          operation: "wait",
                          detail: `${address}: ${reply.error.message}`,
                        }),
                      )
                  : result.exitCode === 0
                    ? Effect.void
                    : Effect.fail(
                        new FleetError({
                          operation: "wait",
                          detail: result.stderr.trim() || `hc wait exited ${result.exitCode}`,
                        }),
                      ),
            }),
          ),
        );

      return {
        roster,

        awaitTurn: (task: string, role: AgentRole | undefined) =>
          Effect.gen(function* () {
            const working = (yield* ofTask(task)).filter(
              (terminal) =>
                (role === undefined || terminal.labels[ROLE] === role) &&
                stateOf(terminal) === "working",
            );
            if (working.length === 0) return;
            // The first wait to finish ends the call, whether it succeeded or
            // failed; the others are interrupted, which ends their hc processes.
            yield* Effect.raceAllFirst(working.map((terminal) => waitOn(terminal.address)));
          }),

        // herdr-app keeps its layout as an hc document, and a space's folder is
        // where its terminals start. Before herdr-app first runs the document is
        // null, which is no spaces rather than an error.
        spaces: call(LayoutDoc, "spaces", "doc.get", { name: "herdr-app" }).pipe(
          Effect.map(({ value }) => (value ?? { spaces: [] }).spaces.map((space) => space.folder)),
        ),

        open: (options: OpenOptions) =>
          Effect.gen(function* () {
            const existing = (yield* roster).find((worker) => worker.task === options.task);
            if (existing) return existing;
            const worktrees = yield* repository
              .worktrees(options.repository)
              .pipe(Effect.mapError(fail("open")));
            const resolution = resolveOpen(worktrees, options);
            switch (resolution.kind) {
              case "adopt":
                yield* Effect.logInfo(
                  `adopting ${options.branch} at ${resolution.path}: nothing runs in it but the worktree survives`,
                );
                break;
              case "restore":
                yield* Effect.logInfo(
                  `putting ${resolution.path} back on ${options.branch}: it was left off its branch`,
                );
                yield* repository
                  .restoreBranch(resolution.path, options.branch)
                  .pipe(Effect.mapError(fail("open")));
                break;
              case "switch":
                yield* repository
                  .checkoutBranch(options.repository, options.branch)
                  .pipe(Effect.mapError(fail("open")));
                break;
              case "create":
                yield* repository
                  .addWorktree(options.repository, options.branch, options.directory)
                  .pipe(Effect.mapError(fail("open")));
            }
            return idle(options.task, resolution.path, options.repository);
          }),

        attach: (options: AttachOptions) =>
          roster.pipe(
            Effect.map(
              (workers) =>
                workers.find((worker) => worker.task === options.task) ??
                idle(options.task, options.repository, options.repository),
            ),
          ),

        spawn: (worker: Worker, options: SpawnOptions) =>
          Effect.gen(function* () {
            // One running agent per role, checked against hc rather than against
            // anything foreman remembers: two agents in one worktree edit over
            // each other. A settled one has stopped and nothing will end it on
            // its own, so it does not refuse; it is ended once the replacement
            // has started.
            const held = (yield* ofTask(worker.task)).filter(
              (terminal) => terminal.labels[ROLE] === options.role,
            );
            const live = held.find((terminal) => stillRunning(stateOf(terminal)));
            if (live) {
              return yield* new FleetError({
                operation: "spawn",
                detail: `${worker.task} already runs a ${options.role} in ${live.address}`,
              });
            }

            const launch = harnessLaunch({ ...options, directory: worker.directory });
            const place = yield* placement(worker.task, worker.repository ?? worker.directory);
            const started = yield* call(Started, "spawn", "terminal.run", {
              argv: launch.argv,
              env: launch.env,
              cwd: worker.directory,
              // A worker belongs to the fleet, not to whichever terminal foreman
              // was started from: ending foreman must not end its agents.
              no_parent: true,
              labels: {
                [FLEET]: "foreman",
                [TASK]: worker.task,
                [ROLE]: options.role,
                ...(worker.repository === undefined ? {} : { [REPOSITORY]: worker.repository }),
                "herdr.space": place.space,
                "herdr.tab": place.tab,
              },
            });
            // herdr-app keeps every terminal it shows, so an agent killed by a
            // signal — the OOM killer's way — is replaced by a shell that looks
            // live and reports nothing. The pid foreman started is what tells
            // that shell from the agent; see `stateOf`.
            yield* call(S.Unknown, "spawn", "terminal.label", {
              terminal: started.address,
              labels: { [PID]: String(started.pid) },
            }).pipe(
              // An agent this dispatch cannot account for is ended, not left to
              // work a task the caller is about to hand back.
              Effect.onError(() =>
                end("spawn", { address: started.address, state: "live" }).pipe(Effect.ignore),
              ),
            );

            yield* Effect.forEach(held, (spent) => end("spawn", spent).pipe(Effect.ignore), {
              discard: true,
            });
            return { kind: options.kind, model: options.model };
          }),

        say: (worker: Worker, role: AgentRole, text: string) =>
          Effect.gen(function* () {
            const target = (yield* ofTask(worker.task)).find(
              (terminal) => terminal.labels[ROLE] === role && terminal.state === "live",
            );
            if (!target) {
              return yield* new FleetError({
                operation: "say",
                detail: `${worker.task} has no live ${role}`,
              });
            }
            yield* call(S.Unknown, "say", "terminal.send", { terminal: target.address, text });
          }),

        screen: (worker: Worker, role: AgentRole, lines: number) =>
          Effect.gen(function* () {
            const target = (yield* ofTask(worker.task)).find(
              (terminal) => terminal.labels[ROLE] === role,
            );
            if (!target) return Option.none<string>();
            const read = yield* call(ScreenText, "screen", "terminal.read", {
              terminal: target.address,
              lines,
            });
            return Option.some(read.text);
          }),

        stop: (worker: Worker, role: AgentRole) =>
          ofTask(worker.task).pipe(
            Effect.flatMap((all) =>
              Effect.forEach(
                all.filter((terminal) => terminal.labels[ROLE] === role),
                (terminal) => end("stop role", terminal),
                { discard: true },
              ),
            ),
          ),

        preview: (worker: Worker, command: string) =>
          Effect.gen(function* () {
            if (worker.worktree === undefined) {
              return yield* new FleetError({
                operation: "preview",
                detail: `${worker.task} has no worktree to preview`,
              });
            }
            const found = yield* call(TerminalList, "preview", "terminal.list", {
              labels: { [PREVIEW]: worker.task },
            });
            const live = found.terminals.find((terminal) => terminal.state === "live");
            if (live) return live.address;
            const place = yield* placement(worker.task, worker.repository ?? worker.directory);
            const started = yield* call(Started, "preview", "terminal.run", {
              argv: [command],
              cwd: worker.worktree,
              name: `preview-${worker.task}`,
              // A dev server outlives the one-shot command that started it.
              no_parent: true,
              labels: {
                [PREVIEW]: worker.task,
                "herdr.space": place.space,
                "herdr.tab": place.tab,
              },
            });
            return started.address;
          }),

        focus: (worker: Worker) =>
          Effect.gen(function* () {
            const all = yield* ofTask(worker.task);
            const shown = all.find((terminal) => terminal.state === "live") ?? all[0];
            if (!shown) {
              return yield* new FleetError({
                operation: "focus",
                detail: `${worker.task} has no terminal to show`,
              });
            }
            const shownBy = yield* exec("focus", "herdr-app", [
              "do",
              "agent.focus",
              JSON.stringify({ terminal: shown.address }),
            ]);
            if (shownBy.exitCode !== 0) {
              return yield* new FleetError({
                operation: "focus",
                detail: shownBy.stderr.trim() || shownBy.stdout.trim() || "herdr-app is not open",
              });
            }
          }),

        close: (options: CloseOptions) =>
          Effect.gen(function* () {
            const all = yield* ofTask(options.task);
            yield* Effect.forEach(all, (terminal) => end("close", terminal), { discard: true });
            const worker = workersOf(all)[0];
            const home = worker?.repository ?? options.repository;
            if (home === undefined) return;
            // A branch-mode task's workspace is the checkout with its branch
            // out, so ending it checks the operator's branch out again; the
            // branch keeps the commits. A dirty tree stays put, and the busy
            // hold names the branch the operator has to clear.
            yield* repository.leaveBranch(home, labelFor(options.task));
            // A worker over the operator's own checkout has no worktree, and
            // that directory is never foreman's to delete.
            if (worker !== undefined && worker.worktree === undefined) return;
            // The checkout itself is listed for the branch in branch mode, and
            // it is the operator's, so it is never the worktree removed.
            const worktree = worktreeFor(yield* repository.worktrees(home), labelFor(options.task));
            if (worktree && worktree.path !== home) {
              yield* repository.removeWorktree(home, worktree.path);
            }
          }).pipe(Effect.ignore),

        /**
         * hc has no notification of its own and the window takes none from
         * outside, so for now a notice is a log line.
         */
        notify: (title: string, body: string) => Effect.logInfo(`notice: ${title}: ${body}`),
      };
    }),
  );
}

/** Labels foreman writes on a worker's terminal. */
const FLEET = "fm.fleet";
const TASK = "fm.task";
const ROLE = "fm.role";
const REPOSITORY = "fm.repo";
const PID = "fm.pid";
/** The task a preview terminal serves the worktree of. */
const PREVIEW = "fm.preview";

/**
 * The tab a task's agents share. herdr-app makes a tab or space for an id it
 * has not seen, so the id is derived from the task and nothing is created up
 * front.
 */
const tabFor = (task: string): string => `fm-${task}`;

/**
 * Where a task's terminal goes, read off the terminals already open: the
 * space of one whose folder is the task's checkout or inside it.
 */
export const placementOf = (
  open: ReadonlyArray<{ readonly cwd: string; readonly labels: Readonly<Record<string, string>> }>,
  task: string,
  checkout: string,
): { readonly space: string; readonly tab: string } => {
  const project = open.find(
    (terminal) =>
      terminal.labels["herdr.space"] !== undefined &&
      terminal.labels[TASK] === undefined &&
      (terminal.cwd === checkout || terminal.cwd.startsWith(`${checkout}/`)),
  );
  return { space: project?.labels["herdr.space"] ?? tabFor(task), tab: tabFor(task) };
};

/** A worker with nothing running in it yet. */
const idle = (task: string, directory: string, repository: string): Worker => ({
  task,
  directory,
  worktree: directory === repository ? undefined : directory,
  repository,
  state: "gone",
  since: undefined,
  roles: new Map(),
});

/**
 * Where a task with nothing running finds its worktree: the one git has out
 * for its branch, else one registered at foreman's own path for it, which is
 * foreman's and only needs putting back on the branch, else a new one. Only a
 * path git has no worktree registered at is a create; anything else collides
 * with `git worktree add` on every attempt.
 *
 * A directory that is the repository itself (branch mode) is a `switch`: the
 * operator's checkout is put on the branch rather than a worktree being made.
 * Once it has the branch out, git lists the checkout for it like any worktree,
 * so a later open adopts it.
 */
export const resolveOpen = (
  worktrees: ReadonlyArray<Worktree>,
  options: { readonly branch: string; readonly directory: string; readonly repository: string },
): { readonly kind: "adopt" | "restore" | "create" | "switch"; readonly path: string } => {
  const onBranch = worktreeFor(worktrees, options.branch);
  if (onBranch) return { kind: "adopt", path: onBranch.path };
  if (options.directory === options.repository) return { kind: "switch", path: options.directory };
  const atPath = worktrees.find(
    (worktree) => worktree.path === options.directory && !worktree.prunable,
  );
  return atPath
    ? { kind: "restore", path: atPath.path }
    : { kind: "create", path: options.directory };
};

/** The worktree git has out for a branch, if one is still on disk. */
const worktreeFor = (worktrees: ReadonlyArray<Worktree>, branch: string): Worktree | undefined =>
  worktrees.find((worktree) => worktree.branch === branch && !worktree.prunable);

/**
 * The workers a set of terminals describes, one per task.
 *
 * A role's state is its newest terminal's: `spawn` ends the spent ones after
 * the replacement starts, so for a moment both exist.
 */
export const workersOf = (all: ReadonlyArray<Terminal>): ReadonlyArray<Worker> => {
  const byTask = new Map<string, Array<Terminal>>();
  for (const terminal of all) {
    const task = terminal.labels[TASK];
    if (task === undefined) continue;
    byTask.set(task, [...(byTask.get(task) ?? []), terminal]);
  }
  return [...byTask].map(([task, mine]) => {
    const newest = [...mine].sort((a, b) => b.created_ms - a.created_ms);
    const roles = new Map<AgentRole, Pane>();
    for (const terminal of newest) {
      const role = terminal.labels[ROLE];
      if (S.is(AgentRoleSchema)(role) && !roles.has(role)) {
        roles.set(role, { state: stateOf(terminal), since: terminal.status_ms ?? undefined });
      }
    }
    const pane = aggregate([...roles.values()]);
    const first = newest[0]!;
    const repository = first.labels[REPOSITORY];
    return {
      task,
      directory: first.cwd,
      worktree: repository === undefined || first.cwd === repository ? undefined : first.cwd,
      repository,
      state: pane?.state ?? "gone",
      since: pane?.since,
      roles,
    } satisfies Worker;
  });
};

/**
 * What one terminal's agent is doing.
 *
 * The status is the agent's own report. A live terminal that has not reported
 * yet is starting up, which is work in progress: reading it as settled would
 * let a second agent into the same worktree before the first has begun. An
 * exited program is `gone`, because a crash and a person closing it to take
 * over look the same from here. So is a live terminal whose program is not
 * the one foreman started: that is the shell `keep` put in place of an agent
 * killed by a signal.
 */
export const stateOf = (terminal: Terminal): WorkerState => {
  if (terminal.state !== "live") return "gone";
  const started = terminal.labels[PID];
  if (started !== undefined && String(terminal.pid) !== started) return "gone";
  switch (terminal.status?.state) {
    case undefined:
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    default:
      return "settled";
  }
};

/**
 * Whether an agent in this state must finish before its role is dispatched
 * again. Only work in progress can collide; a settled agent is editing nothing.
 */
export const stillRunning = (state: WorkerState): boolean =>
  state === "working" || state === "blocked";

/** A worker's pane across its roles: the most demanding state wins. */
const aggregate = (panes: ReadonlyArray<Pane>): Pane | undefined =>
  (["blocked", "working", "settled"] as const)
    .map((state) => panes.find((pane) => pane.state === state))
    .find((pane) => pane !== undefined);

const Terminal = S.Struct({
  address: S.String,
  cwd: S.String,
  state: S.String,
  created_ms: S.Finite,
  pid: S.optional(S.NullOr(S.Finite)),
  labels: S.Record(S.String, S.String),
  status: S.optional(S.NullOr(S.Struct({ state: S.String }))),
  /** When the status last changed, in epoch milliseconds. */
  status_ms: S.optional(S.NullOr(S.Finite)),
});
export type Terminal = S.Schema.Type<typeof Terminal>;

const TerminalList = S.Struct({ terminals: S.Array(Terminal) });

/** The part of herdr-app's layout document foreman reads: where each space is. */
const LayoutDoc = S.Struct({
  value: S.NullOr(S.Struct({ spaces: S.Array(S.Struct({ folder: S.String })) })),
});

const Started = S.Struct({ address: S.String, pid: S.Finite });

/**
 * What `hc wait <terminal> --json` prints when it ends. `reason` says why:
 * the turn ended (`status`), the program exited (`exit`), or the wait checked
 * in (`timeout`). Foreman reads none of its fields: the reply is decoded so the
 * shape is checked against hc's real output, and the exit code decides.
 */
export const TurnWait = S.Struct({
  terminal: S.String,
  ended: S.Boolean,
  reason: S.String,
  status: S.NullOr(S.String),
  turn: S.Finite,
  exit_code: S.NullOr(S.Finite),
});
export type TurnWait = S.Schema.Type<typeof TurnWait>;

/** hc's answer to a wait it could not make: a missing terminal, say. */
const WaitError = S.Struct({
  error: S.Struct({ kind: S.String, message: S.String }),
});

export const WaitReply = S.Union([TurnWait, WaitError]);
export type WaitReply = S.Schema.Type<typeof WaitReply>;

/** What `terminal.read` returns: the screen and history above it, as one text. */
const ScreenText = S.Struct({ text: S.String });

const Reply = S.Struct({
  result: S.optional(S.Unknown),
  error: S.optional(
    S.Struct({
      message: S.String,
      data: S.optional(S.Struct({ kind: S.optional(S.String) })),
    }),
  ),
});
