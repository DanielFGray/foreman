import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, FileSystem, Layer, Option, Schema as S, SubscriptionRef } from "effect";
import { Dispatcher, newWorkspace } from "./dispatcher.ts";
import { expand } from "./composite.ts";
import {
  AgentNode,
  type Composites,
  DEFAULT_PIPELINE,
  describeStandard,
  Drawing,
  LANDINGS,
  type Placement,
  routeTarget,
  routeWorkspace,
  type Standard,
  standardOf,
  standardPipeline,
  toMermaid,
  WORKSPACE_CHOICES,
} from "./pipeline.ts";
import { Prompts } from "./prompt.ts";
import {
  pipelineFor,
  pipelinesPath,
  updatePipelines,
  updatePipelinesFile,
} from "./pipeline-file.ts";
import { pipelinesNow, problemsAgainstLadder, problemsOfDrawing } from "./pipeline-check.ts";
import { writtenDrawingOf, type Flow } from "./pipeline-layout.ts";
import { applyChange, PipelineChange } from "./pipeline-edit.ts";
import { choicesOf } from "./pipeline-belt.ts";
import { policyPath, readPolicy, scopesOf } from "./policy.ts";
import { graphReport } from "./pipeline-graph.ts";
import { Tracker } from "./tracker.ts";
import {
  type Draft,
  draftsPath,
  readDrafts,
  sameDefinition,
  sameDrawing,
  updateDrafts,
} from "./pipeline-draft.ts";
import { PipelineError } from "./pipeline-error.ts";
import { Settings, settings } from "./config.ts";
import { pretend, type TraceReport, traceReport } from "./pipeline-trace.ts";
import { factsOf } from "./pipeline-facts.ts";
import { runSummary, simulateReport } from "./pipeline-simulate.ts";
import { Records } from "./records.ts";
import { prose } from "tasks";
import { readMeasured, ratesOf } from "./run-rates.ts";

export { PipelineError };

/**
 * `foreman pipeline`: read, check and change the pipeline each project runs.
 *
 * A pipeline is checked against the ladder before it is written, so the file
 * holds no pipeline the dispatcher would refuse when it was set. The ladder
 * can still change under it later, which is why every reading checks again.
 */

const project = Argument.String("project");
const source = Argument.String("pipeline").pipe(
  Argument.withDescription("A file holding the pipeline as JSON, or - to read it from stdin"),
);

const json = Flag.Boolean("json").pipe(Flag.withDefault(false));
const flow = Flag.Literals("flow", ["across", "down"]).pipe(
  Flag.withDefault("across"),
  Flag.withDescription(
    "Which way the JSON drawing runs: across (left to right) or down (top to bottom)",
  ),
);

const show = Command.make("show", { project, json, flow }, ({ project, json, flow }) =>
  Effect.gen(function* () {
    if (json) return yield* Console.log(JSON.stringify(yield* shownOf(project, flow), null, 2));
    const written = yield* drawnPipeline(project);
    const reading = yield* livePipeline(project);
    // standardOf reads the drawing as written, so an instance is never "standard".
    const name = Option.match(standardOf(written.drawing), {
      onNone: () => "its own pipeline",
      onSome: describeStandard,
    });
    yield* Console.log(`${project} runs ${name}${written.drawn ? "" : " (the default)"}:`);
    if (reading._tag === "Expanded") {
      yield* Console.log(toMermaid(reading.pipeline));
      for (const problem of yield* problemsAgainstLadder(reading.pipeline))
        yield* Console.error(`problem: ${problem}`);
    } else {
      for (const problem of reading.problems) yield* Console.error(`problem: ${problem}`);
    }
    if ((yield* draftsNow)[project] !== undefined)
      yield* Console.log(
        `a draft is open: foreman pipeline show ${project} --json, then save or discard it`,
      );
  }),
).pipe(
  Command.withDescription(
    "Print the pipeline a project runs as a Mermaid flowchart, or as JSON with --json, with any problems and any open draft",
  ),
);

const check = Command.make("check", { source }, ({ source }) =>
  Effect.gen(function* () {
    yield* checkedDrawing(yield* pipelineFrom(source));
    yield* Console.log("the pipeline can run");
  }),
).pipe(Command.withDescription("Check a pipeline against the ladder without writing it"));

const set = Command.make("set", { project, source }, ({ project, source }) =>
  Effect.gen(function* () {
    yield* runPipeline(project, yield* pipelineFrom(source));
    yield* Console.log(`${project} now runs the pipeline in ${source}`);
  }),
).pipe(Command.withDescription("Check a pipeline, then make it the one a project runs"));

const use = Command.make(
  "use",
  {
    workspace: Argument.Literals("workspace", WORKSPACE_CHOICES).pipe(
      Argument.withDescription(
        "checkout (your checkout, on the task's branch), worktree (a worktree of the task's own) or direct (your checkout, on your branch)",
      ),
    ),
    project: Flag.String("project"),
    land: Flag.Literals("land", LANDINGS).pipe(
      Flag.optional,
      Flag.withDescription(
        "How the task's branch lands: merge (a merge commit; the default), fast-forward, or pull-request (with a publish gate). Not with direct",
      ),
    ),
    onto: Flag.String("onto").pipe(
      Flag.optional,
      Flag.withDescription(
        "The branch the task lands on; absent, the branch your checkout has out. Not with direct",
      ),
    ),
  },
  ({ workspace, project, land, onto }) =>
    Effect.gen(function* () {
      if (workspace === "direct" && (Option.isSome(land) || Option.isSome(onto)))
        return yield* new PipelineError({
          detail:
            "a direct route commits onto your branch and lands nothing, so it takes no --land or --onto",
        });
      const standard: Standard =
        workspace === "direct"
          ? { workspace }
          : {
              workspace,
              how: Option.getOrElse(land, () => "merge" as const),
              onto: Option.getOrUndefined(onto),
            };
      const { drawing, drawn } = yield* drawnPipeline(project);
      // Only a standard variant is replaced, so a pipeline the operator drew by hand is never lost.
      // standardOf reads the drawing as written, so a pipeline with an instance is not standard.
      if (drawn && Option.isNone(standardOf(drawing)))
        return yield* new PipelineError({
          detail: `${project} runs its own drawn pipeline, so use leaves it as it is: see it with foreman pipeline show ${project}, and drop it with foreman pipeline clear ${project}`,
        });
      yield* runPipeline(project, standardPipeline(standard));
      yield* Console.log(`${project} now runs ${describeStandard(standard)}`);
    }),
).pipe(
  Command.withDescription(
    "Draw a standard pipeline for a project: its agents work in your checkout, in a worktree, or directly on your branch, and a task on a branch lands as --land and --onto say",
  ),
);

const edit = Command.make(
  "edit",
  {
    project,
    change: Argument.String("change").pipe(
      Argument.withDescription(
        'One change as JSON, such as {"_tag":"Remove","id":"climb"} or {"_tag":"InsertOn","wire":{"from":"queue","port":"next"},"kind":"gate"}',
      ),
    ),
    json,
    flow,
  },
  ({ project, change, json, flow }) =>
    Effect.gen(function* () {
      const decoded = yield* S.decodeEffect(S.fromJsonString(PipelineChange))(change).pipe(
        Effect.mapError(
          (error) => new PipelineError({ detail: `that change cannot be read: ${error.message}` }),
        ),
      );
      const file = yield* pipelinesNow;
      const draft = (yield* draftsNow)[project] ?? (yield* freshDraft(project));
      const composites = { ...file.composites, ...draft.composites };
      const result = applyChange(draft.pipeline, decoded, composites);
      if (result._tag === "Refused") return yield* new PipelineError({ detail: result.reason });
      yield* updateDrafts(draftsPath(), (drafts) => ({
        ...drafts,
        [project]: {
          ...draft,
          pipeline: result.pipeline,
          composites: { ...draft.composites, ...result.composites },
        },
      }));
      if (json) {
        const shown = yield* shownOf(project, flow);
        return yield* Console.log(
          JSON.stringify({ ...shown, added: result.added ?? null }, null, 2),
        );
      }
      yield* Console.log(
        result.added === undefined
          ? `changed ${project}'s draft`
          : `added ${result.added} to ${project}'s draft`,
      );
    }),
).pipe(
  Command.withDescription(
    "Change a project's draft pipeline, starting one from the pipeline it runs. The pipeline it runs stays as it is until save",
  ),
);

const save = Command.make("save", { project }, ({ project }) =>
  Effect.gen(function* () {
    const draft = (yield* draftsNow)[project];
    if (draft === undefined)
      return yield* new PipelineError({ detail: `${project} has no draft open` });
    const live = yield* drawnPipeline(project);
    if (!sameDrawing(draft.base, live.drawn ? live.drawing : null))
      return yield* new PipelineError({
        detail: `${project}'s pipeline changed since this draft began: discard the draft and draw it again`,
      });
    const file = yield* pipelinesNow;
    const available = { ...file.composites, ...draft.composites };
    const drifted = usedDefinitions(draft.pipeline, available).filter((name) => {
      if (draft.composites[name] !== undefined) return false;
      if (!(name in draft.bases)) return false;
      return !sameDefinition(draft.bases[name] ?? null, file.composites[name] ?? null);
    });
    if (drifted.length > 0) {
      return yield* new PipelineError({
        detail: `a composite this draft uses changed since the draft began: ${drifted.join(", ")}. Discard the draft and draw it again`,
      });
    }
    yield* runPipeline(project, draft.pipeline, draft.composites);
    yield* updateDrafts(draftsPath(), ({ [project]: _saved, ...others }) => others);
    yield* Console.log(`${project} now runs its draft`);
  }),
).pipe(
  Command.withDescription(
    "Check a project's draft, then make it the pipeline the project runs, the same as set",
  ),
);

const discard = Command.make("discard", { project }, ({ project }) =>
  Effect.gen(function* () {
    yield* updateDrafts(draftsPath(), ({ [project]: _dropped, ...others }) => others);
    yield* Console.log(`${project} has no draft open`);
  }),
).pipe(Command.withDescription("Drop a project's draft, and keep the pipeline it runs"));

const clear = Command.make("clear", { project }, ({ project }) =>
  Effect.gen(function* () {
    yield* updatePipelines(pipelinesPath(), ({ [project]: _dropped, ...others }) => others);
    yield* Console.log(`${project} runs the default pipeline`);
  }),
).pipe(Command.withDescription("Drop a project's own pipeline, so it runs the default one"));

/**
 * The prompt an agent block of the draft, else of the pipeline the project
 * runs, would send. It goes through `Prompts.agent`, as `foreman prompt` does
 * for a real task; only the inputs differ: a pretend task with no labels and
 * no runs, on the workspace its route opens, with example paths and an
 * example verify script where a dispatch reads the world.
 */
const prompt = Command.make(
  "prompt",
  { project, block: Argument.String("block") },
  ({ project, block }) =>
    Effect.gen(function* () {
      const file = yield* pipelinesNow;
      const draft = (yield* draftsNow)[project];
      const pipeline = yield* expandedOf(
        draft?.pipeline ?? file.pipelines[project] ?? DEFAULT_PIPELINE,
        { ...file.composites, ...draft?.composites },
      );
      const node = pipeline.nodes.find((one) => one.id === block);
      if (node?.kind !== "agent")
        return yield* new PipelineError({
          detail: `${project}'s pipeline has no agent block named ${block}`,
        });
      const task = {
        ...pretend({ labels: [], size: undefined, priority: 2, parent: undefined }),
        project,
      };
      const workspace = routeWorkspace(pipeline, factsOf(task, pipeline));
      const repository = "<repository>";
      const text = yield* (yield* Prompts).agent(node, {
        task,
        worktree:
          newWorkspace(workspace, { name: project, directory: repository }, task.id) ?? repository,
        repository,
        workspace,
        base: "<base>",
        trunk: routeTarget(pipeline, factsOf(task, pipeline)) ?? "<trunk>",
        verify: "./scripts/verify.sh",
        pipeline,
      });
      yield* Console.log(text);
    }).pipe(Effect.provide(Prompts.Default)),
).pipe(
  Command.withDescription(
    "Print the prompt an agent block of a project's draft, else of the pipeline it runs, would send a pretend task. Writes nothing",
  ),
);

/**
 * The text of instructions `name`, or, with `text`, a write of it to the
 * operator's own `prompts/` directory, which the next dispatch reads.
 */
const instructions = Command.make(
  "instructions",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription(
        "The instructions an agent block reads: its role, unless it names other ones",
      ),
    ),
    text: Argument.String("text").pipe(
      Argument.withDescription(
        "The new text, or - to read it from stdin; with none, print the text",
      ),
      Argument.optional,
    ),
  },
  ({ name, text }) =>
    Effect.gen(function* () {
      const prompts = yield* Prompts;
      if (Option.isNone(text)) {
        const found = yield* prompts.read(name);
        if (found === undefined)
          return yield* new PipelineError({ detail: `no instructions file is named ${name}.md` });
        return yield* Console.log(found);
      }
      const file = yield* prompts.write(name, yield* prose(text.value));
      yield* Console.log(`wrote ${file}`);
    }).pipe(Effect.provide(Prompts.Default)),
).pipe(
  Command.withDescription(
    "Print the instructions an agent block reads, or write new text for them to the operator's prompts directory, which wins over the text foreman ships",
  ),
);

const place = Command.make(
  "place",
  {
    project: Flag.String("project").pipe(
      Flag.optional,
      Flag.withDescription("Only the tasks of this project"),
    ),
  },
  ({ project }) =>
    Effect.gen(function* () {
      const dispatcher = yield* Dispatcher;
      yield* dispatcher.read;
      const { pipelines, placed } = yield* SubscriptionRef.get(dispatcher.state);
      const shown = (name: string) =>
        Option.match(project, { onNone: () => true, onSome: (only) => only === name });
      for (const [name, found] of pipelines) {
        if (!shown(name) || found._tag === "Runs") continue;
        yield* Console.error(`${name} takes no step:`);
        for (const problem of found.problems) yield* Console.error(`  ${problem}`);
      }
      const rows = placed.filter(({ task }) => shown(task.project));
      if (rows.length === 0) return yield* Console.log("no open or in-progress task in a pipeline");
      for (const { task, placement } of rows) {
        yield* Console.log(`${task.id}  ${task.project}  ${whereIs(placement)}  ${task.title}`);
      }
    }),
).pipe(
  Command.withDescription(
    "Print where each open or in-progress task stands in its pipeline: block, state, gates and work blocks left. Dispatches nothing",
  ),
);

const trace = Command.make(
  "trace",
  {
    project,
    request: Argument.String("request").pipe(
      Argument.withDescription(
        'The pretend task and its events as JSON, or - to read it from stdin, such as {"task":{"labels":[],"size":2},"events":["exit:done"]}',
      ),
      Argument.withDefault("-"),
    ),
    json,
  },
  ({ project, request, json }) =>
    Effect.gen(function* () {
      const text = yield* prose(request);
      const { task, events } = yield* S.decodeEffect(S.fromJsonString(TraceRequest))(text).pipe(
        Effect.mapError(
          (error) => new PipelineError({ detail: `that trace cannot be read: ${error.message}` }),
        ),
      );
      const file = yield* pipelinesNow;
      const draft = (yield* draftsNow)[project];
      const live = pipelineFor(file, project);
      if (live._tag === "Failed") return yield* refuse(live.problems);
      const draftPipeline =
        draft === undefined
          ? undefined
          : yield* expandedOf(draft.pipeline, { ...file.composites, ...draft.composites });
      const { ladder, reviewers, attemptsPerLevel } = yield* Settings;
      const report = traceReport(
        project,
        {
          task: {
            labels: task.labels,
            size: task.size,
            priority: task.priority,
            parent: task.parent,
          },
          events,
        },
        { draft: draftPipeline, live },
        { ladder, reviewers, attemptsPerLevel },
      );
      if (json) return yield* Console.log(JSON.stringify(report, null, 2));
      for (const step of report.steps) yield* Console.log(traceLine(step));
      if (report.refused !== null)
        yield* Console.error(
          `refused ${report.refused.event}: the block offers ${report.refused.offers.join(", ") || "nothing"}`,
        );
    }),
).pipe(
  Command.withDescription(
    "Walk a pretend task through a project's draft, else the pipeline it runs, with the events you choose, and print where it stands after each and what its block offers next. Writes nothing",
  ),
);

const simulate = Command.make(
  "simulate",
  {
    project,
    seed: Flag.Int("seed").pipe(
      Flag.withDefault(1),
      Flag.withDescription("Seeds the outcomes drawn; the same seed gives the same run"),
    ),
    hours: Flag.Finite("hours").pipe(
      Flag.withDefault(72),
      Flag.withDescription("How long the run goes on, in hours"),
    ),
    json,
  },
  ({ project, seed, hours, json }) =>
    Effect.gen(function* () {
      const records = yield* Records;
      const ready = yield* records.ready(Option.some(project));
      const claimed = yield* records.claimed(project);
      const epics = yield* records.epicsOver(ready);
      const { policy } = yield* readPolicy(policyPath());
      const rates = ratesOf(yield* readMeasured);
      const file = yield* pipelinesNow;
      const draft = (yield* draftsNow)[project];
      const live = pipelineFor(file, project);
      const { ladder, reviewers, attemptsPerLevel, pollInterval } = yield* Settings;
      const liveForSim =
        live._tag === "Failed"
          ? { pipeline: DEFAULT_PIPELINE, drawn: live.drawn, problems: live.problems }
          : {
              pipeline: live.pipeline,
              drawn: live.drawn,
              problems: yield* problemsAgainstLadder(live.pipeline),
            };
      const draftExpanded =
        draft === undefined
          ? undefined
          : yield* readingOf(draft.pipeline, { ...file.composites, ...draft.composites });
      const draftForSim =
        draftExpanded === undefined
          ? undefined
          : draftExpanded._tag === "Failed"
            ? { pipeline: DEFAULT_PIPELINE, problems: draftExpanded.problems }
            : { pipeline: draftExpanded.pipeline, problems: draftExpanded.problems };
      const report = simulateReport(
        {
          project,
          ready,
          claimed,
          epics,
          now: new Date(),
          slots: policy.slots,
          pollSeconds: pollInterval,
        },
        {
          draft: draftForSim,
          live: liveForSim,
        },
        rates,
        { ladder, reviewers, attemptsPerLevel },
        { seed, hours },
      );
      if (json) return yield* Console.log(JSON.stringify(report));
      if (report.draft !== null) yield* Console.log(runSummary(report.draft));
      yield* Console.log(runSummary(report.saved));
    }),
).pipe(
  Command.withDescription(
    "Play a project's ready and claimed tasks through its draft and through the pipeline it runs, on the same seed, with outcomes drawn from the measured rates of each rung, and print how each run went. Writes nothing",
  ),
);

const graph = Command.make("graph", { project, json }, ({ project, json }) =>
  Effect.gen(function* () {
    const tracker = yield* Tracker;
    const records = yield* Records;
    const items = (yield* Effect.forEach(["open", "in_progress"] as const, (status) =>
      tracker.list({ project, status }),
    )).flat();
    const dependencies = yield* tracker.dependencies(project);
    const known = new Map(items.map((item) => [item.id, item.status]));
    for (const id of new Set(dependencies.map((edge) => edge.dependsOn))) {
      if (known.has(id)) continue;
      const found = yield* tracker.lookup(id);
      if (Option.isSome(found)) known.set(id, found.value.status);
    }
    const { policy } = yield* readPolicy(policyPath());
    const report = graphReport({
      project,
      items,
      dependencies,
      statusOf: (id) => known.get(id),
      policy,
      scopes: yield* scopesOf(policy.grants, records.lookup, records.children),
      pipeline: yield* expandedLive(project),
    });
    if (json) return yield* Console.log(JSON.stringify(report));
    for (const item of report.items) {
      const waits = item.waitsFor.length === 0 ? "" : `  waits for ${item.waitsFor.join(", ")}`;
      const granted = item.grant === null ? "" : `  granted by ${item.grant.scope}`;
      yield* Console.log(
        `${item.column} ${item.id} ${item.status} ${item.title}${waits}${granted}`,
      );
    }
    yield* Console.log(
      `a grant gives: ${report.grantSteps.join(" ") || "nothing; every gated step is on"}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Print a project's open and claimed tasks and epics in columns by what they wait for, with the grant that covers each and the steps a grant gives. Writes nothing",
  ),
);

/**
 * `foreman pipeline`. `place` reads the dispatcher's view of the world, so it
 * takes the dispatcher's services; `simulate` and `graph` read the task store; the
 * others read only the pipelines file and the ladder.
 */
export const pipelineCommand = <E>(services: Layer.Layer<Dispatcher, E>) =>
  Command.make("pipeline", {}).pipe(
    Command.withDescription(`Read, check and change each project's pipeline (${pipelinesPath()})`),
    Command.withSubcommands([
      show,
      check,
      set,
      use,
      edit,
      save,
      discard,
      clear,
      prompt,
      instructions,
      Command.provide(trace, settings),
      Command.provide(simulate, Layer.mergeAll(Records.layer, settings)),
      Command.provide(graph, Records.layer),
      Command.provide(place, services),
    ]),
  );

/** A placement in words: the block, its state, the gates before it, and the work blocks left. */
const whereIs = (placement: Placement): string =>
  placement._tag === "Outside"
    ? "outside the pipeline"
    : placement._tag === "Parked"
      ? `parked at ${placement.node}`
      : placement._tag === "ExitGone"
        ? `waiting for the operator: ${placement.reason}`
        : `at ${placement.node.id} ${placement.state}  gates: ${placement.gates.map((gate) => `${gate.id} (${gate.step})`).join(", ") || "none"}  ahead: ${placement.ahead}`;

/** What `trace` reads: the pretend task, and the events chosen so far. */
const TraceRequest = S.Struct({
  task: S.Struct({
    labels: S.Array(S.String).pipe(S.withDecodingDefault(Effect.succeed([]))),
    size: S.optional(S.Int),
    priority: S.Int.pipe(S.withDecodingDefault(Effect.succeed(2))),
    parent: S.optional(S.String),
  }),
  events: S.Array(S.String).pipe(S.withDecodingDefault(Effect.succeed([]))),
});

/** A trace step in words: the event, where the task stands, and what comes next. */
const traceLine = (step: TraceReport["steps"][number]): string =>
  [
    step.event ?? "start",
    whereIs(step.placement),
    step.rung === null
      ? ""
      : step.rung._tag === "Dispatch"
        ? `on ${step.rung.name}`
        : step.rung._tag,
    step.parked === null ? "" : `parked: ${step.parked}`,
    `offers: ${step.offers.join(", ") || "nothing"}`,
  ]
    .filter((part) => part !== "")
    .join("  ");

const refuse = (problems: ReadonlyArray<string>) =>
  new PipelineError({
    detail: `the pipeline cannot run:\n${problems.map((p) => `  ${p}`).join("\n")}`,
  });

const pipelineFrom = (source: string) =>
  Effect.gen(function* () {
    const text =
      source === "-"
        ? yield* prose(source)
        : yield* (yield* FileSystem.FileSystem).readFileString(source);
    return yield* S.decodeEffect(S.fromJsonString(Drawing))(text).pipe(
      Effect.mapError(
        (error) => new PipelineError({ detail: `${source} is no pipeline: ${error.message}` }),
      ),
    );
  });

/** Expansion reading for a project: Expanded with the pipeline, or Failed. */
const livePipeline = (project: string) =>
  pipelinesNow.pipe(Effect.map((file) => pipelineFor(file, project)));

/** The drawing as the operator wrote it, before expansion. */
const drawnPipeline = (project: string) =>
  pipelinesNow.pipe(
    Effect.map((file) => {
      const drawn = file.pipelines[project];
      return drawn === undefined
        ? { drawing: DEFAULT_PIPELINE as Drawing, drawn: false as const }
        : { drawing: drawn, drawn: true as const };
    }),
  );

/** The expanded pipeline, or refuse with expansion problems. */
const expandedLive = (project: string) =>
  livePipeline(project).pipe(
    Effect.flatMap((reading) =>
      reading._tag === "Failed"
        ? Effect.fail(refuse(reading.problems))
        : Effect.succeed(reading.pipeline),
    ),
  );

const draftsNow = Effect.gen(function* () {
  const read = yield* readDrafts(draftsPath());
  if (read.error !== undefined) return yield* new PipelineError({ detail: read.error });
  return read.value;
});

/** A draft that starts as the drawing the project runs now, as written. */
const freshDraft = (project: string) =>
  Effect.gen(function* () {
    const file = yield* pipelinesNow;
    const drawn = file.pipelines[project];
    const drawing = drawn ?? (DEFAULT_PIPELINE as Drawing);
    return {
      base: drawn === undefined ? null : drawing,
      pipeline: drawing,
      composites: {},
      bases: { ...file.composites },
    } satisfies Draft;
  });

/**
 * Composite definition names a drawing reaches, directly or through nested
 * instances inside other definitions (`docs/composite-blocks.md`).
 */
const usedDefinitions = (
  drawing: Drawing,
  composites: Composites,
  seen: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> => {
  const names: string[] = [];
  for (const node of drawing.nodes) {
    if (node.kind !== "composite") continue;
    if (seen.has(node.of)) continue;
    names.push(node.of);
    const nested = composites[node.of];
    if (nested === undefined) continue;
    names.push(
      ...usedDefinitions({ nodes: nested.blocks }, composites, new Set(seen).add(node.of)),
    );
  }
  return [...new Set(names)];
};

/**
 * Expand `drawing` with these definitions, or refuse with the expansion
 * problems. Every draft reader goes through here so there is one path.
 */
const expandedOf = (drawing: Drawing, composites: Composites) => {
  const result = expand(drawing, composites);
  return result._tag === "Failed"
    ? Effect.fail(refuse(result.problems))
    : Effect.succeed(result.pipeline);
};

/**
 * Expansion then ladder check. A tagged result: never an unexpanded drawing
 * beside problems.
 */
const readingOf = (drawing: Drawing, composites: Composites) =>
  Effect.gen(function* () {
    const result = expand(drawing, composites);
    if (result._tag === "Failed") {
      return { _tag: "Failed" as const, problems: result.problems };
    }
    return {
      _tag: "Expanded" as const,
      pipeline: result.pipeline,
      problems: yield* problemsAgainstLadder(result.pipeline),
    };
  });

/**
 * Refuses a drawing whose expansion, read with these definitions (else the
 * pipelines file's), fails or does not run against the ladder. `check` and
 * `set` both stop here, so they agree on what runs.
 */
const checkedDrawing = (drawing: Drawing, composites?: Composites) =>
  Effect.gen(function* () {
    const file = yield* pipelinesNow;
    const problems = yield* problemsOfDrawing(drawing, composites ?? file.composites);
    if (problems.length > 0) return yield* refuse(problems);
  });

/**
 * Checks a drawing, then makes the as-written drawing the one `project` runs.
 * Both set and save write through here. `addedComposites` are definitions the
 * draft carried (from MakeComposite); a save writes them beside the drawing.
 */
const runPipeline = (project: string, drawing: Drawing, addedComposites: Composites = {}) =>
  Effect.gen(function* () {
    const file = yield* pipelinesNow;
    // A draft's new name was free when the draft began; another project's save may have taken it since.
    const taken = Object.keys(addedComposites).filter(
      (name) => file.composites[name] !== undefined,
    );
    if (taken.length > 0) {
      return yield* refuse(
        taken.map((name) => `a composite named ${name} now exists: rename it and save again`),
      );
    }
    const composites = { ...file.composites, ...addedComposites };
    yield* checkedDrawing(drawing, composites);
    yield* updatePipelinesFile(pipelinesPath(), (current) => ({
      pipelines: { ...current.pipelines, [project]: drawing },
      composites: { ...current.composites, ...addedComposites },
    }));
  });

/**
 * What `show --json` prints: the pipeline as the operator drew it (composite
 * instances still one block), its expansion problems, its drawing, the
 * definitions the palette lists, and the same for the project's draft when
 * one is open (`docs/composite-blocks.md`).
 */
const shownOf = (project: string, flow: Flow) =>
  Effect.gen(function* () {
    const file = yield* pipelinesNow;
    const { drawing: written, drawn } = yield* drawnPipeline(project);
    const reading = pipelineFor(file, project);
    const draft = (yield* draftsNow)[project];
    const available = { ...file.composites, ...(draft?.composites ?? {}) };
    const draftJson =
      draft === undefined
        ? null
        : yield* readingOf(draft.pipeline, available).pipe(
            Effect.map((draftReading) =>
              viewOf(draft.pipeline, draftReading.problems, available, flow),
            ),
          );
    const problems =
      reading._tag === "Failed" ? reading.problems : yield* problemsAgainstLadder(reading.pipeline);
    return {
      project,
      drawn,
      choices: {
        ...choicesOf(available),
        // Definitions this project's draft made. `composite show` reads only stored ones, so the pane refuses to open these until the draft is saved.
        unsaved: Object.keys(draft?.composites ?? {}).sort(),
      },
      ...viewOf(written, problems, available, flow),
      draft: draftJson,
    };
  });

/**
 * The as-written drawing and the expanded ids each instance covers, so a page
 * that cannot load this module still draws instances as one block and places
 * tasks that stand inside on them.
 */
const viewOf = (
  drawing: Drawing,
  problems: ReadonlyArray<string>,
  composites: Composites,
  flow: Flow,
) => {
  return { pipeline: drawing, problems, drawing: writtenDrawingOf(drawing, composites, flow) };
};
