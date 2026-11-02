import { Effect, FileSystem, Option, Schema as S } from "effect";
import { Pipeline, type PipelineNode, problemsOf, STANDARD_PIPELINE } from "./pipeline.ts";
import { configDirectory, type Read, rewrite } from "./shared-file.ts";

/**
 * The pipelines the operator drew, one per project, in a file of their own
 * beside the policy.
 *
 * A project with no entry runs the standard pipeline. The file sits in the
 * policy's directory, so the dispatcher's watch on that directory sees a
 * change to either file.
 */
export const Pipelines = S.Record(S.String, Pipeline);
export type Pipelines = typeof Pipelines.Type;

/**
 * The file as written: the pipelines under the format's version. A file
 * without a version predates the workspace blocks, and reads through
 * `withWorkspace`; the next write stores it in this form, so a pipeline the
 * operator then draws with no worktree is never given one again.
 */
const PipelinesFile = S.Struct({ version: S.Literal(2), pipelines: Pipelines });
type PipelinesFile = typeof PipelinesFile.Type;

/** Where the pipelines live: `$FOREMAN_PIPELINES`, else beside the policy. */
export const pipelinesPath = (): string =>
  process.env["FOREMAN_PIPELINES"] ?? `${configDirectory()}/pipelines.json`;

/**
 * The pipelines as the file states them.
 *
 * A missing file holds none, so every project runs the standard pipeline. A
 * file that does not decode holds none either, with the reason: what reads it
 * decides what an unreadable drawing stops.
 */
export const readPipelines = (path: string) =>
  readFile(path).pipe(
    Effect.map((read): Read<Pipelines> => ({ ...read, value: read.value.pipelines })),
  );

/** Rewrites the pipelines through `change`, the one way anything writes them. */
export const updatePipelines = (path: string, change: (pipelines: Pipelines) => Pipelines) =>
  rewrite(path, PipelinesFile, readFile, (file) => ({
    version: 2 as const,
    pipelines: change(file.pipelines),
  }));

/**
 * A pipeline drawn before the workspace blocks, as it ran then: every task
 * had a branch and a worktree of its own, so each source leads into a branch
 * block and a worktree block before whatever it led into.
 */
export const withWorkspace = (pipeline: Pipeline): Pipeline => {
  const taken = new Set(pipeline.nodes.map((node) => node.id));
  const fresh = (base: string) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };
  return {
    ...pipeline,
    nodes: pipeline.nodes.flatMap((node): ReadonlyArray<PipelineNode> => {
      if (node.kind !== "source") return [node];
      const branch = fresh("branch");
      const worktree = fresh("worktree");
      return [
        { ...node, next: branch },
        { kind: "branch", id: branch, next: worktree },
        { kind: "worktree", id: worktree, next: node.next },
      ];
    }),
  };
};

const NONE: PipelinesFile = { version: 2, pipelines: {} };

/** The file as stored, with a file from before the version read as it ran then. */
const readFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(text)) return { value: NONE, error: undefined, text: undefined };
    // A file that is neither form reports why it is not the current one.
    return yield* S.decodeEffect(S.fromJsonString(PipelinesFile))(text.value).pipe(
      Effect.catch((current) =>
        S.decodeEffect(S.fromJsonString(Pipelines))(text.value).pipe(
          Effect.map((old): PipelinesFile => ({
            version: 2,
            pipelines: Object.fromEntries(
              Object.entries(old).map(([project, pipeline]) => [project, withWorkspace(pipeline)]),
            ),
          })),
          Effect.mapError(() => current),
        ),
      ),
      Effect.map((value): Read<PipelinesFile> => ({ value, error: undefined, text: text.value })),
      Effect.catch((error) =>
        Effect.succeed<Read<PipelinesFile>>({
          value: NONE,
          error: `${path} does not decode: ${error.message}`,
          text: text.value,
        }),
      ),
    );
  });

/** The pipeline `project` runs, and whether the operator drew it. */
export const pipelineFor = (
  pipelines: Pipelines,
  project: string,
): { readonly pipeline: Pipeline; readonly drawn: boolean } => {
  const drawn = pipelines[project];
  return drawn === undefined
    ? { pipeline: STANDARD_PIPELINE, drawn: false }
    : { pipeline: drawn, drawn: true };
};

/**
 * A project's pipeline as one reading found it.
 *
 * A stopped project takes no step, and `problems` says why: its drawing fails
 * validation, or the file does not decode. It never runs the standard pipeline
 * instead, because a flow the operator did not draw is worse than stopping.
 */
export type ProjectPipeline =
  | { readonly _tag: "Runs"; readonly pipeline: Pipeline; readonly drawn: boolean }
  | { readonly _tag: "Stopped"; readonly problems: ReadonlyArray<string> };

/** What `project` runs, from one reading of the file, checked against these rungs. */
export const projectPipeline = (
  read: { readonly value: Pipelines; readonly error: string | undefined },
  project: string,
  rungs: ReadonlyArray<string>,
): ProjectPipeline => {
  if (read.error !== undefined) return { _tag: "Stopped", problems: [read.error] };
  const { pipeline, drawn } = pipelineFor(read.value, project);
  const problems = problemsOf(pipeline, rungs);
  return problems.length > 0 ? { _tag: "Stopped", problems } : { _tag: "Runs", pipeline, drawn };
};
