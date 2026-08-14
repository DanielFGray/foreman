import { FileSystem } from "@effect/platform";
import { Duration, Effect, Option, Schema } from "effect";
import { tmpdir } from "node:os";
import { Settings } from "./config.ts";
import { directoryFor, Fleet, labelFor, type Worker, type WorkerState } from "./fleet.ts";
import { isPlan, PLAN, Prog } from "./prog.ts";
import { Prompts } from "./prompt.ts";

/**
 * Plan mode: the front half of the pipeline.
 *
 * The operator hands foreman a rough plan; a planner agent researches the
 * project and turns it into a specification, and a tasker agent turns that
 * specification into tasks in the backlog. It is the missing front half of the
 * same pipeline the daemon drains: today the backlog is filled by hand and
 * foreman only takes from it.
 *
 * Everything about a plan lives in the task store. The plan is an epic
 * (`ep-...`) labelled `plan`, created in draft; the planner writes the spec
 * into the epic's description; the tasker files the generated tasks as its
 * children. The stages are sequenced by the epic's stored status, which is why
 * the daemon needs no changes for this: an epic is never claimed, never
 * `in_progress`, and never ready, so the running dispatcher ignores the plan
 * while picking up its opened children as ordinary work.
 *
 *   draft   → planner writes spec → `prog open` →   open
 *   open    → tasker files tasks  → `prog done` →   done
 *
 * A plan run is one synchronous command, resumable after interruption with
 * `foreman plan --epic ep-...`: the workspace is re-adopted by its label and
 * the stage is read from the stored status, so a half-finished plan continues
 * rather than being orphaned.
 */
export const runPlan = (input: PlanInput) =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    const fleet = yield* Fleet;
    const prog = yield* Prog;

    if (Option.isSome(input.epic) && Option.isSome(input.plan)) {
      return yield* new PlanError({
        detail:
          "--file cannot be combined with --epic: a resumed plan already has its plan written.",
      });
    }

    const epic = yield* Option.match(input.epic, {
      onSome: (id) => adopt(settings.projects, input.project, id),
      onNone: () =>
        createEpic(
          input,
          settings.projects.map((p) => p.name),
        ),
    });

    const project = settings.projects.find((p) => p.name === epic.project);
    if (!project) {
      return yield* new PlanError({
        detail: `${epic.id} is in "${epic.project}", which is not configured.`,
      });
    }

    const worker = yield* fleet.open({
      task: epic.id,
      repository: project.directory,
      branch: labelFor(epic.id),
      directory: directoryFor(project.name, epic.id),
    });

    const initial = epic.status;
    let status = initial;
    if (status === "draft") {
      status = yield* runStage("planning", epic.id, worker, project.directory);
    }
    if (stageFor(status) === "tasking") {
      status = yield* runStage("tasking", epic.id, worker, project.directory);
    }

    // Only a completed run takes the workspace down; a failed or interrupted
    // one stays so `--epic` can resume it.
    yield* fleet.close(worker);

    if (status === "done") {
      const count = (yield* prog.children(epic.id)).length;
      if (initial !== "done") {
        yield* prog.log(epic.id, `foreman: plan complete — ${count} tasks filed.`);
      }
      yield* Effect.logInfo(`plan ${epic.id} complete: ${count} tasks under ${project.name}`);
    } else {
      // Only a canceled epic reaches this branch — a failed run throws before
      // the close above, which is what keeps the workspace for `--epic`. Here
      // the run completed without the tasker finishing, so nothing is left.
      yield* Effect.logInfo(`plan ${epic.id} ended ${status}; nothing to resume`);
    }
    return epic.id;
  });

/** What the CLI parses off the command line and hands to runPlan. */
export interface PlanInput {
  /** `--project`; when absent, the sole configured project is used. */
  readonly project: Option.Option<string>;
  /** The rough plan text from `--file`; absent means `$EDITOR` or `--epic`. */
  readonly plan: Option.Option<string>;
  /** `--title`; when absent, derived from the plan's first line. */
  readonly title: Option.Option<string>;
  /** `--epic`; resume an interrupted plan instead of creating one. */
  readonly epic: Option.Option<string>;
}

/** Which agent is running for the plan right now. */
export type PlanStage = "planning" | "tasking";

/**
 * The next thing a plan needs, from the epic's stored status.
 *
 * Draft means the planner has not written the specification; anything after
 * draft up to completion means the planner has, so the tasker runs next.
 */
export const stageFor = (status: string): "planning" | "tasking" | "complete" => {
  if (status === "draft") return "planning";
  if (status === "done" || status === "canceled") return "complete";
  return "tasking";
};

/**
 * One poll of a running stage: keep waiting, move on, or give up.
 *
 * An agent that is working (or blocked waiting for the operator) means the
 * stage is alive. Once it settles, the only evidence of what it accomplished is
 * the epic's status: the planner's job was to leave draft, the tasker's was to
 * reach done. Settling without that transition is a failure — except for the
 * tasker leaving `open`, which the caller treats as "tasks exist, bookkeeping
 * incomplete" and reports for a resume rather than guessing.
 */
export const decide = (
  stage: PlanStage,
  workerState: WorkerState,
  epicStatus: string,
): "wait" | "advance" | "failed" => {
  if (workerState === "working" || workerState === "blocked") return "wait";
  if (stageFor(epicStatus) === "complete") return "advance";
  if (stage === "planning" && epicStatus !== "draft") return "advance";
  return "failed";
};

/** A title for the plan epic, from the first non-empty line of the plan. */
export const titleFor = (plan: string): string => {
  const first = plan
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const title = (first ?? "")
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s*/, "")
    .trim();
  return title === "" ? "Plan" : title.slice(0, 80);
};

/**
 * The project a plan runs in. `--project` wins when given; otherwise a single
 * configured project is unambiguous and the rest are not.
 */
export const resolveProject = (
  requested: Option.Option<string>,
  configured: ReadonlyArray<string>,
): Option.Option<string> => {
  if (Option.isSome(requested)) {
    return configured.includes(requested.value) ? requested : Option.none();
  }
  const only = configured[0];
  return configured.length === 1 && only !== undefined ? Option.some(only) : Option.none();
};

/**
 * Creates the plan epic, opening the editor when no plan text was given.
 *
 * The rough plan becomes the epic's description; the planner later replaces it
 * with the full specification.
 */
const createEpic = (input: PlanInput, configured: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const prog = yield* Prog;

    const project = resolveProject(input.project, configured);
    if (Option.isNone(project)) {
      const requested = Option.getOrElse(input.project, () => "");
      const detail =
        requested !== ""
          ? `--project ${requested} is not configured (configured: ${configured.join(", ")})`
          : `--project is required when more than one project is configured (configured: ${configured.join(", ")})`;
      return yield* new PlanError({ detail });
    }

    const text = yield* Option.match(input.plan, {
      onSome: (plan) => Effect.succeed(Option.some(plan)),
      onNone: () => draftPlan,
    });
    if (Option.isNone(text)) {
      return yield* new PlanError({
        detail: "no plan given — pass --file or write the plan in the editor.",
      });
    }

    const plan = Option.getOrElse(text, () => "");
    const title = Option.getOrElse(input.title, () => titleFor(plan));
    const id = yield* prog.addEpic(
      Option.getOrElse(project, () => ""),
      title,
      plan,
      [PLAN],
    );
    return yield* prog.show(id);
  });

/**
 * Adopts an interrupted plan so `--epic ep-...` resumes it. The workspace is
 * re-opened by its label later; here the epic is validated as a plan in a
 * configured project.
 */
const adopt = (
  projects: ReadonlyArray<{ readonly name: string }>,
  requested: Option.Option<string>,
  id: string,
) =>
  Effect.gen(function* () {
    const prog = yield* Prog;

    if (!/^ep-[0-9a-f]{6}$/.test(id)) {
      return yield* new PlanError({ detail: `not a plan epic id: ${id}.` });
    }
    const item = yield* prog
      .show(id)
      .pipe(Effect.mapError(() => new PlanError({ detail: `no such item: ${id}.` })));
    if (item.type !== "epic" || !isPlan(item)) {
      return yield* new PlanError({
        detail: `${id} is not a plan epic (it is ${item.type} and lacks the "${PLAN}" label).`,
      });
    }
    if (Option.isSome(requested) && requested.value !== item.project) {
      return yield* new PlanError({
        detail: `--project ${requested.value} does not match ${id}'s project (${item.project}).`,
      });
    }
    if (!projects.some((p) => p.name === item.project)) {
      return yield* new PlanError({
        detail: `${id} is in "${item.project}", which is not configured.`,
      });
    }
    return item;
  });

/** Runs one stage: spawns the agent, then waits for its verdict. */
const runStage = (stage: PlanStage, epic: string, worker: Worker, repository: string) =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    const fleet = yield* Fleet;
    const prog = yield* Prog;
    const prompts = yield* Prompts;

    const item = yield* prog.show(epic);
    const kind = stage === "planning" ? settings.planner : settings.tasker;
    const prompt =
      stage === "planning"
        ? yield* prompts.planner(item, worker.directory, repository)
        : yield* prompts.tasker(item, worker.directory, repository);

    yield* fleet.spawn(worker, { kind, prompt, role: "author" });
    yield* Effect.logInfo(`plan ${epic}: ${stage} by ${kind} in ${worker.workspace}`);
    return yield* waitFor(stage, epic);
  });

/**
 * Polls until the stage's agent reaches a verdict, read from the epic status.
 *
 * Sleeps before the first probe: a just-spawned agent reports its state late,
 * and on a resume the previous attempt's settled pane can still be the
 * workspace's loudest status for a moment. Plans have no timeout — they can
 * legitimately run for a long time — so an operator who wants out interrupts
 * the command, which leaves the workspace in place for `--epic` to resume.
 */
const waitFor = (stage: PlanStage, epic: string) =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    const fleet = yield* Fleet;
    const prog = yield* Prog;

    for (;;) {
      yield* Effect.sleep(Duration.seconds(settings.pollInterval));
      const worker = (yield* fleet.roster).find((candidate) => candidate.task === epic);
      const item = yield* prog.show(epic);
      const result = decide(stage, worker?.state ?? "gone", item.status);
      if (result === "advance") return item.status;
      if (result === "failed") {
        return yield* new PlanError({
          detail: `the ${stage} agent stopped with the epic still ${item.status} (workspace ${worker?.state ?? "gone"}). Resume with \`foreman plan --epic ${epic}\`.`,
        });
      }
    }
  });

/** Drafts the rough plan in `$EDITOR`, returning None when nothing was written. */
const draftPlan = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "vi";
  const file = `${tmpdir()}/foreman-plan-${Date.now()}.md`;

  yield* fs
    .writeFileString(file, "")
    .pipe(Effect.mapError(() => new PlanError({ detail: `could not write ${file}.` })));
  const result = yield* Effect.sync(() =>
    Bun.spawnSync([editor, file], { stdio: ["inherit", "inherit", "inherit"] }),
  );
  if (result.exitCode !== 0) {
    yield* fs.remove(file).pipe(Effect.ignore);
    return Option.none();
  }
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError(() => new PlanError({ detail: `could not read ${file}.` })));
  yield* fs.remove(file).pipe(Effect.ignore);
  return text.trim() === "" ? Option.none() : Option.some(text);
});

export class PlanError extends Schema.TaggedError<PlanError>()("PlanError", {
  detail: Schema.String,
}) {}
