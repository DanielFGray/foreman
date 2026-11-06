/**
 * The operator's policy: which steps the fleet may take by itself, for which
 * tasks, and how many agents may work at once.
 *
 * The five steps spend tokens or write to the operator's checkout, so each
 * runs only where the policy allows it:
 *
 * - `author` starts a task nobody has tried.
 * - `climb` starts a task again after an attempt that did not finish it, on
 *   the next rung or the same one. Its failures are recorded either way; this
 *   only decides whether the retry waits for the operator.
 * - `review` sends a reviewer to a finished branch.
 * - `publish` pushes an approved branch and opens its pull request, for a
 *   land block that lands by pull request. It spends no model, but a push and
 *   a pull request are visible outside this machine.
 * - `land` proves the merge in the proving ground and applies it to the
 *   checkout.
 *
 * Settle, tidy, reclaim and recover have one right answer each, so they run
 * on every tick while the fleet is `running` (see `modeOf`). A `paused` or
 * `idle` fleet only reads the world and publishes the reading: no step can
 * run, and a tick that cannot act writes nothing, so the operator can stop
 * every write the fleet makes with one switch.
 *
 * The policy is an intention, and an intention is the one thing foreman cannot
 * read back from the world. It lives in a file the operator edits through
 * `foreman policy` or the Foreman pane, so it survives a restart and both front ends
 * write it through `updatePolicy`. The dispatcher writes it too, to record
 * which tasks a grant has admitted.
 *
 * Commands the operator gives by hand (`foreman dispatch`, the Foreman pane's launch)
 * are not gated: the operator pressing the key is the permission.
 */
import { Effect, FileSystem, Option, Schema as S, SchemaGetter } from "effect";
import type { Item } from "./records.ts";
import { policyPath } from "./paths.ts";
import { rewrite } from "./shared-file.ts";

export const STEPS = ["author", "climb", "review", "publish", "land"] as const;
export type Step = (typeof STEPS)[number];

/**
 * What the fleet does with a step by itself.
 *
 * - `on`: the dispatcher takes the step as soon as a task reaches it.
 * - `ask`: the dispatcher takes no action and reports the task as waiting for
 *   one approval; `foreman approve` writes a one-task grant for the step.
 * - `off`: nothing happens, and the step is not reported.
 */
export const STEP_MODES = ["on", "ask", "off"] as const;
export type StepMode = (typeof STEP_MODES)[number];

/**
 * The tracker a project takes its tasks from. `tasks` is the local store;
 * `github` and `linear` are the adapters of docs/issue-trackers.md.
 */
export const TRACKERS = ["tasks", "github", "linear"] as const;
export type TrackerName = (typeof TRACKERS)[number];

/**
 * A widening of the default for one task or epic.
 *
 * `remaining` counts tasks, not steps: a grant admits at most that many
 * distinct tasks, and keeps covering each one it admitted until that task is
 * finished, so a task it authored is not left without its review or its
 * landing when the count runs out. Absent means no limit. `admitted` is the
 * dispatcher's record of which tasks those are.
 */
export const Grant = S.Struct({
  scope: S.String,
  steps: S.Array(S.Literals(STEPS)),
  remaining: S.optional(S.Int.check(S.isGreaterThan(0))),
  admitted: S.Array(S.String).pipe(S.withDecodingDefault(Effect.succeed([]))),
});
export type Grant = typeof Grant.Type;

/** Which Linear team (by key) and Linear project (by name) hold a project's tasks. */
export const LinearPlace = S.Struct({ team: S.String, project: S.String });
export type LinearPlace = typeof LinearPlace.Type;

/**
 * How foreman posts its review on a pull request (docs/issue-trackers.md, section 3).
 *
 * - `comment` posts the verdict as a comment review with the one `gh` account,
 *   because GitHub refuses an approval from the PR's own author.
 * - `approve` posts a real approval or a request for changes with a second
 *   credential: `GH_TOKEN` is set from the environment variable
 *   `reviewTokenEnv` names, for that one call.
 */
export const PULL_REQUEST_REVIEWS = ["comment", "approve"] as const;
export type PullRequestReview = (typeof PULL_REQUEST_REVIEWS)[number];

/**
 * What a pull request closed without a merge does to its task: `park` it for
 * the operator, `requeue` it at the same rung, or `cancel` it.
 */
export const CLOSED_PULL_REQUESTS = ["park", "requeue", "cancel"] as const;
export type ClosedPullRequest = (typeof CLOSED_PULL_REQUESTS)[number];

export const PullRequestPolicy = S.Struct({
  review: S.optional(S.Literals(PULL_REQUEST_REVIEWS)),
  reviewTokenEnv: S.optional(S.String),
  closed: S.optional(S.Literals(CLOSED_PULL_REQUESTS)),
});
export type PullRequestPolicy = typeof PullRequestPolicy.Type;

/**
 * The cadence a schedule fires on. A tagged union keyed by the kind's field
 * (`{ landed: N }` now; `{ days: N }` later), because the kinds are the same
 * question asked differently and a later kind is one more case, not a new field.
 */
const Landed = S.Struct({
  landed: S.Int.check(S.isGreaterThan(0)),
});
export const Every = S.Union([Landed]);
export type Every = typeof Every.Type;

/**
 * One operator pattern: a cadence, the task it files, and the instructions
 * that shape the work the task means.
 */
export const Schedule = S.Struct({
  name: S.String,
  every: Every,
  /** The task's title, as a template: `{{ project }}` and `{{ since }}`. */
  title: S.String,
  /** The operator's own labels on the filed task, beside the schedule's. */
  labels: S.optional(S.Array(S.String)).pipe(S.withDecodingDefault(Effect.succeed([]))),
  /**
   * The instructions file the filed task's author reads, by its name without
   * `.md`: `retro` and `retro.md` both decode to `retro`, and the policy writes
   * `retro`. The name is the one `Prompts` reads, so the suffix is stripped here,
   * where every writer and every reader of the policy file meets it.
   */
  template: S.String.pipe(
    S.decodeTo(S.String, {
      decode: SchemaGetter.transform((name: string) => name.replace(/\.md$/i, "")),
      encode: SchemaGetter.passthrough(),
    }),
  ),
});
export type Schedule = typeof Schedule.Type;

/**
 * One project's own settings. A step set here replaces the fleet default for
 * that project's tasks; a paused project takes no step, grants included;
 * `tracker` names where the project's tasks live.
 */
export const ProjectPolicy = S.Struct({
  paused: S.optional(S.Boolean),
  /** Absent means `tasks`. */
  tracker: S.optional(S.Literals(TRACKERS)),
  /** The Linear team key and Linear project name; set with the `linear` tracker. */
  linear: S.optional(LinearPlace),
  /** How a land block that lands by pull request treats the PR. Absent means `PULL_REQUEST_DEFAULTS`. */
  pullRequest: S.optional(PullRequestPolicy),
  steps: S.optional(
    S.Struct({
      author: S.optional(S.Literals(STEP_MODES)),
      climb: S.optional(S.Literals(STEP_MODES)),
      review: S.optional(S.Literals(STEP_MODES)),
      publish: S.optional(S.Literals(STEP_MODES)),
      land: S.optional(S.Literals(STEP_MODES)),
    }),
  ),
  /** The recurring patterns this project keeps, filed from a template on a cadence. */
  schedules: S.optional(S.Array(Schedule)),
});
export type ProjectPolicy = typeof ProjectPolicy.Type;

export const Policy = S.Struct({
  /** Suspends every step, grants included, without forgetting them. */
  paused: S.Boolean.pipe(S.withDecodingDefault(Effect.succeed(false))),
  /** How many agents may be working at once. */
  slots: S.Int.check(S.isGreaterThan(0)).pipe(S.withDecodingDefault(Effect.succeed(3))),
  default: S.Struct({
    author: S.Literals(STEP_MODES),
    climb: S.Literals(STEP_MODES),
    review: S.Literals(STEP_MODES),
    // A policy file that names no `publish` step reads it as off.
    publish: S.Literals(STEP_MODES).pipe(S.withDecodingDefault(Effect.succeed("off" as const))),
    land: S.Literals(STEP_MODES),
  }).pipe(
    S.withDecodingDefault(
      Effect.succeed({
        author: "off",
        climb: "off",
        review: "off",
        publish: "off",
        land: "off",
      }),
    ),
  ),
  grants: S.Array(Grant).pipe(S.withDecodingDefault(Effect.succeed([]))),
  /** Per-project overrides of `default` and `paused`, keyed by project name. */
  projects: S.Record(S.String, ProjectPolicy).pipe(S.withDecodingDefault(Effect.succeed({}))),
});
export type Policy = typeof Policy.Type;

/** The policy with no file: the fleet takes no step until the operator says so. */
export const DEFAULT_POLICY: Policy = S.decodeSync(Policy)({});

/**
 * What a tick may do under a policy.
 *
 * - `running`: a step or a grant is on, so the tick settles, tidies, reclaims,
 *   recovers and fills.
 * - `paused`: the operator stopped the fleet; grants are kept for later.
 * - `idle`: no step is on and no grant exists, so no step could run.
 *
 * Only `running` writes to the world. The other two read and publish.
 */
export const MODES = ["running", "paused", "idle"] as const;
export type Mode = (typeof MODES)[number];

/** What `step` is set to for `project`: its own entry, else the fleet default. */
export const modeFor = (policy: Policy, project: string, step: Step): StepMode =>
  policy.projects[project]?.steps?.[step] ?? policy.default[step];

/** Every step's mode for `project`, by `modeFor`. */
export const stepModesFor = (policy: Policy, project: string): Record<Step, StepMode> => ({
  author: modeFor(policy, project, "author"),
  climb: modeFor(policy, project, "climb"),
  review: modeFor(policy, project, "review"),
  publish: modeFor(policy, project, "publish"),
  land: modeFor(policy, project, "land"),
});

/**
 * Running when any project could take a step: a default step is on, a project
 * that is not paused overrides a step to something other than off, or a grant
 * exists. The global pause wins over all of it.
 */
export const modeOf = (policy: Policy): Mode =>
  policy.paused
    ? "paused"
    : STEPS.some((step) => policy.default[step] !== "off") ||
        Object.values(policy.projects).some(
          (entry) =>
            !entry.paused && STEPS.some((step) => (entry.steps?.[step] ?? "off") !== "off"),
        ) ||
        policy.grants.length > 0
      ? "running"
      : "idle";

/** Why a step may or may not run for a task. */
export type Permit =
  | { readonly _tag: "Denied" }
  | { readonly _tag: "Default" }
  /** The step waits for one approval: its default is `ask` and no grant covers the task. */
  | { readonly _tag: "Ask" }
  | {
      readonly _tag: "Granted";
      readonly scope: string;
      readonly admits: boolean;
    };

/**
 * Whether `step` may run for `task` without the operator.
 *
 * `scopes` maps each grant's scope to the unfinished tasks it reaches, which
 * is the one fact a grant cannot carry itself: an epic's descendants change as
 * work is filed. `admits` says the grant takes on a task it has not admitted
 * before, which the caller records with `admit` once the step has run.
 */
export const permit = (
  policy: Policy,
  scopes: Scopes,
  task: { readonly id: string; readonly project: string },
  step: Step,
): Permit => {
  if (policy.paused || policy.projects[task.project]?.paused) return { _tag: "Denied" };
  const mode = modeFor(policy, task.project, step);
  if (mode === "on") return { _tag: "Default" };
  for (const grant of policy.grants) {
    if (!grant.steps.includes(step)) continue;
    if (grant.admitted.includes(task.id))
      return { _tag: "Granted", scope: grant.scope, admits: false };
    if (!scopes.get(grant.scope)?.has(task.id)) continue;
    if (grant.remaining !== undefined && grant.admitted.length >= grant.remaining) continue;
    return { _tag: "Granted", scope: grant.scope, admits: true };
  }
  return mode === "ask" ? { _tag: "Ask" } : { _tag: "Denied" };
};

/** Each grant's scope, mapped to the unfinished tasks at or under it. */
export type Scopes = ReadonlyMap<string, ReadonlySet<string>>;

/** Records that the grant on `scope` took on `task`. */
export const admit = (policy: Policy, scope: string, task: string): Policy => ({
  ...policy,
  grants: policy.grants.map((grant) =>
    grant.scope === scope && !grant.admitted.includes(task)
      ? { ...grant, admitted: [...grant.admitted, task] }
      : grant,
  ),
});

/**
 * Drops each grant that can do nothing more: none of its admitted tasks is
 * still unfinished, and it can admit no new one, because its count is spent or
 * its scope holds no unfinished task.
 *
 * A grant whose scope `scopes` does not name is kept: it was added after the
 * reading that built the map, so the map says nothing about it.
 */
export const expire = (policy: Policy, scopes: Scopes): Policy => ({
  ...policy,
  grants: policy.grants.filter((grant) => {
    const open = scopes.get(grant.scope);
    if (open === undefined) return true;
    if (grant.admitted.some((task) => open.has(task))) return true;
    const spent = grant.remaining !== undefined && grant.admitted.length >= grant.remaining;
    return !spent && open.size > 0;
  }),
});

/**
 * Adds or widens the grant on `scope`. One grant per scope, so a second grant
 * on the same item adds its steps rather than starting a second count. A
 * grant given no count keeps the count it had.
 */
export const grant = (
  policy: Policy,
  scope: string,
  steps: ReadonlyArray<Step>,
  remaining: number | undefined,
): Policy => {
  const existing = policy.grants.find((g) => g.scope === scope);
  const merged: Grant = {
    scope,
    steps: STEPS.filter((step) => steps.includes(step) || existing?.steps.includes(step)),
    ...(remaining === undefined
      ? existing?.remaining === undefined
        ? {}
        : { remaining: existing.remaining }
      : { remaining }),
    admitted: existing?.admitted ?? [],
  };
  return {
    ...policy,
    grants: existing
      ? policy.grants.map((g) => (g.scope === scope ? merged : g))
      : [...policy.grants, merged],
  };
};

/**
 * The unfinished tasks at or under `roots`, walking epics through `children`.
 * A task id names itself; an epic covers every descendant task.
 */
export const scopeOf = <E>(
  roots: ReadonlyArray<Item>,
  children: (id: string) => Effect.Effect<ReadonlyArray<Item>, E>,
): Effect.Effect<ReadonlySet<string>, E> =>
  Effect.gen(function* () {
    const tasks = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const item = stack.pop()!;
      if (item.type === "epic") stack.push(...(yield* children(item.id)));
      else if (!FINISHED.has(item.status)) tasks.add(item.id);
    }
    return tasks;
  });

/**
 * Each grant's scope, mapped to the unfinished tasks it reaches. A scope the
 * tracker has no item for reaches none.
 */
export const scopesOf = <E>(
  grants: ReadonlyArray<Grant>,
  lookup: (id: string) => Effect.Effect<Option.Option<Item>, E>,
  children: (id: string) => Effect.Effect<ReadonlyArray<Item>, E>,
): Effect.Effect<Scopes, E> =>
  Effect.forEach(grants, (grant) =>
    lookup(grant.scope).pipe(
      Effect.flatMap((item) =>
        Option.isSome(item)
          ? scopeOf([item.value], children)
          : Effect.succeed<ReadonlySet<string>>(new Set()),
      ),
      Effect.map((tasks) => [grant.scope, tasks] as const),
    ),
  ).pipe(Effect.map((entries): Scopes => new Map(entries)));

const FINISHED: ReadonlySet<string> = new Set(["done", "canceled"]);

export { policyPath };

/**
 * The policy as the file states it.
 *
 * A missing file is the default, which takes no step. A file that does not
 * decode is paused, with the reason, because a policy foreman cannot read is
 * not permission for anything, and the operator has to see why the fleet
 * stopped.
 */
export const readPolicy = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(text)) return { policy: DEFAULT_POLICY, error: undefined, text: undefined };
    return yield* S.decodeEffect(S.fromJsonString(Policy))(text.value).pipe(
      Effect.map((policy) => ({ policy, error: undefined, text: text.value })),
      Effect.catch((error) =>
        Effect.succeed({
          policy: { ...DEFAULT_POLICY, paused: true },
          error: `${path} does not decode, so the fleet is paused: ${error.message}`,
          text: text.value,
        }),
      ),
    );
  });

/**
 * Rewrites the policy through `change`, the one way anything writes it.
 *
 * Losing the race `rewrite` describes loses one write: an expiry the
 * dispatcher makes again next tick, an admission that lets a grant take on one
 * task more than its count, or an operator's change that the next reading
 * shows did not happen.
 */
export const updatePolicy = (path: string, change: (policy: Policy) => Policy) =>
  rewrite(
    path,
    Policy,
    (path) =>
      readPolicy(path).pipe(
        Effect.map(({ policy, error, text }) => ({ value: policy, error, text })),
      ),
    change,
  ).pipe(
    Effect.catchTag("RewriteError", (error) =>
      Effect.fail(new PolicyError({ detail: error.detail })),
    ),
  );

export class PolicyError extends S.TaggedError<PolicyError>()("PolicyError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}

/** Changes one project's entry; an entry left holding nothing is dropped. */
const editProject = (
  policy: Policy,
  project: string,
  edit: (entry: ProjectPolicy) => ProjectPolicy,
): Policy => {
  const next = edit(policy.projects[project] ?? {});
  const { [project]: _dropped, ...others } = policy.projects;
  const empty =
    next.paused === undefined &&
    next.tracker === undefined &&
    next.pullRequest === undefined &&
    Object.keys(next.steps ?? {}).length === 0 &&
    (next.schedules ?? []).length === 0;
  return { ...policy, projects: empty ? others : { ...others, [project]: next } };
};

/** Pauses or resumes one project. Resuming removes the flag rather than storing `false`. */
export const pauseProject = (policy: Policy, project: string, paused: boolean): Policy =>
  editProject(policy, project, ({ paused: _was, ...rest }) =>
    paused ? { ...rest, paused } : rest,
  );

/** Sets one step for one project, replacing the fleet default there. */
export const setProjectStep = (
  policy: Policy,
  project: string,
  step: Step,
  mode: StepMode,
): Policy =>
  editProject(policy, project, (entry) => ({ ...entry, steps: { ...entry.steps, [step]: mode } }));

/**
 * Drops a project's step and pause settings, so it follows the fleet default
 * again. The tracker and pull-request choices stay: they say where the tasks
 * live and how they land, not settings with a fleet default.
 */
export const clearProject = (policy: Policy, project: string): Policy =>
  editProject(policy, project, ({ tracker, linear, pullRequest, schedules }) => ({
    ...(tracker === undefined ? {} : { tracker }),
    ...(linear === undefined ? {} : { linear }),
    ...(pullRequest === undefined ? {} : { pullRequest }),
    // A schedule is the operator's intention for the project, like its tracker:
    // clearing the step overrides must not drop it.
    ...((schedules ?? []).length === 0 ? {} : { schedules }),
  }));

/** The tracker `project` takes its tasks from. */
export const trackerOf = (policy: Policy, project: string): TrackerName =>
  policy.projects[project]?.tracker ?? "tasks";

/**
 * Chooses one project's tracker. `tasks` removes the key rather than storing
 * the default. `linear` is the Linear place, stored only with the `linear`
 * tracker, because no other tracker reads it.
 */
export const setProjectTracker = (
  policy: Policy,
  project: string,
  tracker: TrackerName,
  linear?: LinearPlace,
): Policy =>
  editProject(policy, project, ({ tracker: _was, linear: _place, ...rest }) => ({
    ...rest,
    ...(tracker === "tasks" ? {} : { tracker }),
    ...(tracker === "linear" && linear !== undefined ? { linear } : {}),
  }));

/** A project's pull-request settings, with the defaults for what it leaves out. */
export const pullRequestOf = (
  policy: Policy,
  project: string,
): {
  readonly review: PullRequestReview;
  readonly reviewTokenEnv: string | undefined;
  readonly closed: ClosedPullRequest;
} => {
  const entry = policy.projects[project]?.pullRequest;
  return {
    review: entry?.review ?? "comment",
    reviewTokenEnv: entry?.reviewTokenEnv,
    closed: entry?.closed ?? "park",
  };
};

/** Changes some of one project's pull-request settings and keeps the others. */
export const setPullRequest = (
  policy: Policy,
  project: string,
  change: PullRequestPolicy,
): Policy =>
  editProject(policy, project, (entry) => ({
    ...entry,
    pullRequest: { ...entry.pullRequest, ...change },
  }));

/** The schedules one project keeps, in the order the operator gave them. */
export const schedulesOf = (policy: Policy, project: string): ReadonlyArray<Schedule> =>
  policy.projects[project]?.schedules ?? [];

/** Adds one schedule to one project, replacing one of the same name. */
export const addSchedule = (policy: Policy, project: string, schedule: Schedule): Policy =>
  editProject(policy, project, (entry) => ({
    ...entry,
    schedules: [...(entry.schedules ?? []).filter((one) => one.name !== schedule.name), schedule],
  }));

/** Removes one schedule of one project, dropping the entry when none is left. */
export const removeSchedule = (policy: Policy, project: string, name: string): Policy =>
  editProject(policy, project, (entry) => ({
    ...entry,
    schedules: (entry.schedules ?? []).filter((one) => one.name !== name),
  }));
