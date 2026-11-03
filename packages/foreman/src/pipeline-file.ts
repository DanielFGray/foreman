import { Effect, FileSystem, Option, Schema as S, Struct } from "effect";
import {
  AgentNode,
  BranchNode,
  CheckNode,
  DoneNode,
  GateNode,
  LandNode,
  ParkNode,
  Pipeline,
  type PipelineNode,
  type RungOffer,
  RouterNode,
  SourceNode,
  WorktreeNode,
  instructionProblems,
  problemsOf,
  DEFAULT_PIPELINE,
  standardExits,
} from "./pipeline.ts";
import { configDirectory, type Read, rewrite } from "./shared-file.ts";

/**
 * The pipelines the operator drew, one per project, in a file of their own
 * beside the policy.
 *
 * A project with no entry runs the default pipeline. The file sits in the
 * policy's directory, so the dispatcher's watch on that directory sees a
 * change to either file.
 */
export const Pipelines = S.Record(S.String, Pipeline);
export type Pipelines = typeof Pipelines.Type;

/**
 * The file as written: the pipelines under the format's version. Older files
 * read as they ran then, and the next write stores them in this form:
 *
 * - version 2 wired each agent and check block to one `next` block. Each gets
 *   the standard exits for its role, advancing to that block, and returning
 *   to the queue charged to the author.
 * - a file without a version predates the workspace blocks as well, and also
 *   reads through `withWorkspace`, so a pipeline the operator then draws with
 *   no worktree is never given one again.
 */
const PipelinesFile = S.Struct({ version: S.Literal(3), pipelines: Pipelines });
type PipelinesFile = typeof PipelinesFile.Type;

/** An agent or a check block as version 2 drew it: one wire on. */
const WiredOn = { next: S.String };
const OldNode = S.Union([
  SourceNode,
  RouterNode,
  GateNode,
  BranchNode,
  WorktreeNode,
  LandNode,
  DoneNode,
  ParkNode,
  AgentNode.mapFields((fields) => ({ ...Struct.omit(fields, ["exits", "stopped"]), ...WiredOn })),
  CheckNode.mapFields((fields) => ({ ...Struct.omit(fields, ["exits"]), ...WiredOn })),
]);
type OldNode = typeof OldNode.Type;
const OldPipelines = S.Record(S.String, S.Struct({ nodes: S.Array(OldNode) }));
const OldFile = S.Struct({ version: S.Literal(2), pipelines: OldPipelines });

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
    version: 3 as const,
    pipelines: change(file.pipelines),
  }));

/** A version 2 pipeline as it ran: each agent and check block takes the standard exits for its role. */
export const withExits = (pipeline: { readonly nodes: ReadonlyArray<OldNode> }): Pipeline => ({
  nodes: pipeline.nodes.map((node): PipelineNode => {
    if (node.kind !== "agent" && node.kind !== "check") return node;
    const { next, ...rest } = node;
    return { ...rest, exits: standardExits(node, next) };
  }),
});

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

const NONE: PipelinesFile = { version: 3, pipelines: {} };

const each = (
  pipelines: typeof OldPipelines.Type,
  upgrade: (pipeline: { readonly nodes: ReadonlyArray<OldNode> }) => Pipeline,
): PipelinesFile => ({
  version: 3,
  pipelines: Object.fromEntries(
    Object.entries(pipelines).map(([project, pipeline]) => [project, upgrade(pipeline)]),
  ),
});

/** The file as stored, with a file from before the version read as it ran then. */
const readFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(text)) return { value: NONE, error: undefined, text: undefined };
    // A file that is no form reports why it is not the current one.
    return yield* S.decodeEffect(S.fromJsonString(PipelinesFile))(text.value).pipe(
      Effect.catch((current) =>
        S.decodeEffect(S.fromJsonString(OldFile))(text.value).pipe(
          Effect.map((old) => each(old.pipelines, withExits)),
          Effect.catch(() =>
            S.decodeEffect(S.fromJsonString(OldPipelines))(text.value).pipe(
              Effect.map((old) => each(old, (pipeline) => withWorkspace(withExits(pipeline)))),
            ),
          ),
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
    ? { pipeline: DEFAULT_PIPELINE, drawn: false }
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

/**
 * What `project` runs, from one reading of the file, checked against these
 * rungs and the instructions texts read for its agent blocks.
 */
export const projectPipeline = (
  read: { readonly value: Pipelines; readonly error: string | undefined },
  project: string,
  rungs: ReadonlyArray<RungOffer>,
  instructions: ReadonlyMap<string, string>,
): ProjectPipeline => {
  if (read.error !== undefined) return { _tag: "Stopped", problems: [read.error] };
  const { pipeline, drawn } = pipelineFor(read.value, project);
  const problems = [...problemsOf(pipeline, rungs), ...instructionProblems(pipeline, instructions)];
  return problems.length > 0 ? { _tag: "Stopped", problems } : { _tag: "Runs", pipeline, drawn };
};
