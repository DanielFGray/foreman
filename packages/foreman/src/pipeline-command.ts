import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, FileSystem, Layer, Option, Schema as S, SubscriptionRef } from "effect";
import { Dispatcher } from "./dispatcher.ts";
import {
  instructionNames,
  instructionProblems,
  Pipeline,
  type Placement,
  problemsOf,
  toMermaid,
} from "./pipeline.ts";
import { Prompts } from "./prompt.ts";
import { pipelineFor, pipelinesPath, readPipelines, updatePipelines } from "./pipeline-file.ts";
import { readLadder } from "./registry.ts";
import { drawingOf } from "./pipeline-layout.ts";
import { mayAuthor, mayReview } from "./ladder.ts";

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

const show = Command.make(
  "show",
  { project, json: Flag.Boolean("json").pipe(Flag.withDefault(false)) },
  ({ project, json }) =>
    Effect.gen(function* () {
      const read = yield* readPipelines(pipelinesPath());
      if (read.error !== undefined) return yield* new PipelineError({ detail: read.error });
      const { pipeline, drawn } = pipelineFor(read.value, project);
      const problems = yield* problemsAgainstLadder(pipeline);
      if (json) {
        return yield* Console.log(
          JSON.stringify(
            { project, drawn, pipeline, problems, drawing: drawingOf(pipeline) },
            null,
            2,
          ),
        );
      }
      yield* Console.log(
        drawn ? `${project} runs its own pipeline:` : `${project} runs the standard pipeline:`,
      );
      yield* Console.log(toMermaid(pipeline));
      for (const problem of problems) yield* Console.error(`problem: ${problem}`);
    }),
).pipe(
  Command.withDescription(
    "Print the pipeline a project runs as a Mermaid flowchart, or as JSON with --json, with any problems",
  ),
);

const check = Command.make("check", { source }, ({ source }) =>
  Effect.gen(function* () {
    const pipeline = yield* pipelineFrom(source);
    const problems = yield* problemsAgainstLadder(pipeline);
    if (problems.length > 0) return yield* refuse(problems);
    yield* Console.log("the pipeline can run");
  }),
).pipe(Command.withDescription("Check a pipeline against the ladder without writing it"));

const set = Command.make("set", { project, source }, ({ project, source }) =>
  Effect.gen(function* () {
    const pipeline = yield* pipelineFrom(source);
    const problems = yield* problemsAgainstLadder(pipeline);
    if (problems.length > 0) return yield* refuse(problems);
    yield* updatePipelines(pipelinesPath(), (pipelines) => ({ ...pipelines, [project]: pipeline }));
    yield* Console.log(`${project} now runs the pipeline in ${source}`);
  }),
).pipe(Command.withDescription("Check a pipeline, then make it the one a project runs"));

const clear = Command.make("clear", { project }, ({ project }) =>
  Effect.gen(function* () {
    yield* updatePipelines(pipelinesPath(), ({ [project]: _dropped, ...others }) => others);
    yield* Console.log(`${project} runs the standard pipeline`);
  }),
).pipe(Command.withDescription("Drop a project's own pipeline, so it runs the standard one"));

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

/**
 * `foreman pipeline`. `place` reads the dispatcher's view of the world, so it
 * takes the dispatcher's services; the others read only the pipelines file and
 * the ladder.
 */
export const pipelineCommand = <E>(services: Layer.Layer<Dispatcher, E>) =>
  Command.make("pipeline", {}).pipe(
    Command.withDescription(`Read, check and change each project's pipeline (${pipelinesPath()})`),
    Command.withSubcommands([show, check, set, clear, Command.provide(place, services)]),
  );

/** A placement in words: the block, its state, the gates before it, and the work blocks left. */
const whereIs = (placement: Placement): string =>
  placement._tag === "Outside"
    ? "outside the pipeline"
    : placement._tag === "Parked"
      ? `parked at ${placement.node}`
      : `at ${placement.node.id} ${placement.state}  gates: ${placement.gates.map((gate) => `${gate.id} (${gate.step})`).join(", ") || "none"}  ahead: ${placement.ahead}`;

export class PipelineError extends S.TaggedError<PipelineError>()("PipelineError", {
  detail: S.String,
}) {}

/**
 * The problems that stop `pipeline` running: against the ladder, and in the
 * instructions files its agent blocks read.
 */
const problemsAgainstLadder = (pipeline: Pipeline) =>
  Effect.gen(function* () {
    const ladder = yield* readLadder;
    const texts = yield* (yield* Prompts).instructions(instructionNames(pipeline));
    return [
      ...problemsOf(
        pipeline,
        ladder.map((rung) => ({
          name: rung.name,
          author: mayAuthor(rung),
          review: mayReview(rung),
        })),
      ),
      ...instructionProblems(pipeline, texts),
    ];
  }).pipe(Effect.provide(Prompts.Default));

const refuse = (problems: ReadonlyArray<string>) =>
  new PipelineError({
    detail: `the pipeline cannot run:\n${problems.map((p) => `  ${p}`).join("\n")}`,
  });

const pipelineFrom = (source: string) =>
  Effect.gen(function* () {
    const text =
      source === "-"
        ? yield* Effect.promise(() => Bun.stdin.text())
        : yield* (yield* FileSystem.FileSystem).readFileString(source);
    return yield* S.decodeEffect(S.fromJsonString(Pipeline))(text).pipe(
      Effect.mapError(
        (error) => new PipelineError({ detail: `${source} is no pipeline: ${error.message}` }),
      ),
    );
  });
