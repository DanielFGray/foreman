/**
 * `foreman cutover exit-ids`: the one-time conversion of the pipelines and
 * drafts files to exits with ids.
 *
 * A run stores the id of the exit it named, and placement looks the id up. A
 * file from before ids gave each exit only a name, which runs stored instead,
 * so each exit's id is its name: every run already stored places as before.
 * An author's `already-done` was the one name foreman's code read, as the
 * claim that trunk already does the task; it becomes the declared claim
 * (`empty: claim`), the property code reads now.
 *
 * This module is the only reader of the older forms. The dispatcher and every
 * command read only the current ones, so this runs once, after the upgrade is
 * installed and before the dispatcher starts again.
 */
import { Effect, FileSystem, Option, Schema as S, Struct } from "effect";
import {
  AgentNode,
  BranchNode,
  CheckNode,
  DoneNode,
  type Exit,
  GateNode,
  LandNode,
  ParkNode,
  type Pipeline,
  type PipelineNode,
  RouterNode,
  SourceNode,
  standardExits,
  WorktreeNode,
} from "./pipeline.ts";
import { DraftsFile, draftsPath } from "./pipeline-draft.ts";
import { PipelinesFile, pipelinesPath } from "./pipeline-file.ts";
import { type Read, rewrite } from "./shared-file.ts";

/** What the cutover found in each file, and what it wrote or would write. */
export interface CutoverReport {
  readonly path: string;
  /** The form the file was in: a version, `none` for no file, `current` when there was nothing to do. */
  readonly from: string;
  readonly projects: ReadonlyArray<string>;
}

/**
 * Converts both files in place, or with `dryRun` reads them and writes
 * nothing. A file already in the current form, or absent, is left as it is.
 */
export const cutoverExitIds = ({ dryRun }: { readonly dryRun: boolean }) =>
  Effect.gen(function* () {
    const pipelines = yield* convertFile(
      pipelinesPath(),
      PipelinesFile,
      upgradePipelines,
      (file) => Object.keys(file.pipelines),
      dryRun,
    );
    const drafts = yield* convertFile(
      draftsPath(),
      DraftsFile,
      upgradeDrafts,
      (file) => Object.keys(file.drafts),
      dryRun,
    );
    return [pipelines, drafts] as const;
  });

/** The report as lines an operator reads. */
export const cutoverLines = (
  reports: ReadonlyArray<CutoverReport>,
  dryRun: boolean,
): ReadonlyArray<string> =>
  reports.map(({ path, from, projects }) =>
    from === "none"
      ? `${path}: no file`
      : from === "current"
        ? `${path}: already has exit ids`
        : `${path}: ${dryRun ? "would convert" : "converted"} ${from} (${projects.join(", ") || "no projects"})`,
  );

/**
 * A pipelines file's text in the current form, from any older one, with the
 * form it was in; `current` when it already is current.
 */
export const upgradePipelines = (text: string) =>
  decoded(PipelinesFile, text).pipe(
    Effect.map((file) => ({ from: "current", file })),
    Effect.catch((current) =>
      Effect.firstSuccessOf([
        decoded(V4File, text).pipe(
          Effect.map((old) => ({ from: "version 4", file: fileOf(old.pipelines, withIds) })),
        ),
        decoded(V3File, text).pipe(
          Effect.map((old) => ({
            from: "version 3",
            file: fileOf(old.pipelines, (pipeline) => withReviewers(withIds(pipeline))),
          })),
        ),
        decoded(V2File, text).pipe(
          Effect.map((old) => ({
            from: "version 2",
            file: fileOf(old.pipelines, (pipeline) => withReviewers(withExits(pipeline))),
          })),
        ),
        decoded(Unversioned, text).pipe(
          Effect.map((old) => ({
            from: "no version",
            file: fileOf(old, (pipeline) => withReviewers(withWorkspace(withExits(pipeline)))),
          })),
        ),
        // A file in no form reports why it is not the current one.
      ]).pipe(Effect.mapError(() => current)),
    ),
  );

/** A drafts file's text in the current form, from any older one; `current` when it already is. */
export const upgradeDrafts = (text: string) =>
  decoded(DraftsFile, text).pipe(
    Effect.map((file) => ({ from: "current", file })),
    Effect.catch((current) =>
      Effect.firstSuccessOf([
        decoded(V2Drafts, text).pipe(
          Effect.map((old) => ({ from: "version 2", file: draftsOf(old.drafts, withIds) })),
        ),
        decoded(V1Drafts, text).pipe(
          Effect.map((old) => ({
            from: "version 1",
            file: draftsOf(old.drafts, (pipeline) => withReviewers(withIds(pipeline))),
          })),
        ),
      ]).pipe(Effect.mapError(() => current)),
    ),
  );

const decoded = <A, I>(schema: S.Codec<A, I>, text: string) =>
  S.decodeEffect(S.fromJsonString(schema))(text);

/** An exit as files before ids drew it: a name, which runs stored. */
const NamedOnly = S.Struct({
  name: S.String,
  to: S.String,
  fails: S.optional(S.Literals(["author", "self"])),
});
type NamedOnly = typeof NamedOnly.Type;

const withoutIds = <Fields extends { readonly exits: unknown }>(fields: Fields) => ({
  ...fields,
  exits: S.Array(NamedOnly),
});

const UnchangedNodes = [
  SourceNode,
  RouterNode,
  GateNode,
  BranchNode,
  WorktreeNode,
  LandNode,
  DoneNode,
  ParkNode,
] as const;

/** A node of version 3 or 4: exits named, with no id. */
const NamedNode = S.Union([
  ...UnchangedNodes,
  AgentNode.mapFields(withoutIds),
  CheckNode.mapFields(withoutIds),
]);
type NamedNode = typeof NamedNode.Type;
const NamedPipeline = S.Struct({ nodes: S.Array(NamedNode) });
type NamedPipeline = typeof NamedPipeline.Type;
const NamedPipelines = S.Record(S.String, NamedPipeline);

/** A node of version 2 or before: an agent or a check wired to one `next` block. */
const WiredNode = S.Union([
  ...UnchangedNodes,
  AgentNode.mapFields((fields) => ({
    ...Struct.omit(fields, ["exits", "stopped"]),
    next: S.String,
  })),
  CheckNode.mapFields((fields) => ({ ...Struct.omit(fields, ["exits"]), next: S.String })),
]);
type WiredNode = typeof WiredNode.Type;
const WiredPipelines = S.Record(S.String, S.Struct({ nodes: S.Array(WiredNode) }));

const V4File = S.Struct({ version: S.Literal(4), pipelines: NamedPipelines });
const V3File = S.Struct({ version: S.Literal(3), pipelines: NamedPipelines });
const V2File = S.Struct({ version: S.Literal(2), pipelines: WiredPipelines });
const Unversioned = WiredPipelines;

const NamedDrafts = S.Record(
  S.String,
  S.Struct({ base: S.NullOr(NamedPipeline), pipeline: NamedPipeline }),
);
const V2Drafts = S.Struct({ version: S.Literal(2), drafts: NamedDrafts });
const V1Drafts = S.Struct({ version: S.Literal(1), drafts: NamedDrafts });

/**
 * A pipeline whose exits had names alone, each exit's id its name. The author
 * exit `already-done` was the claim by its name, so it declares the claim.
 */
export const withIds = (pipeline: NamedPipeline): Pipeline => ({
  nodes: pipeline.nodes.map((node): PipelineNode => {
    if (node.kind !== "agent" && node.kind !== "check") return node;
    const exits = node.exits.map((exit): Exit =>
      node.kind === "agent" && node.role === "author" && exit.name === "already-done"
        ? { ...exit, id: exit.name, empty: "claim" }
        : { ...exit, id: exit.name },
    );
    return { ...node, exits };
  }),
});

/** A version 2 pipeline as it ran: each agent and check block takes the standard exits for its role. */
export const withExits = (pipeline: { readonly nodes: ReadonlyArray<WiredNode> }): Pipeline => ({
  nodes: pipeline.nodes.map((node): PipelineNode => {
    if (node.kind !== "agent" && node.kind !== "check") return node;
    const { next, ...rest } = node;
    return { ...rest, exits: standardExits(node, next) };
  }),
});

/**
 * A pipeline drawn before the reviewers, as it ran then: its review blocks read
 * by the rule `above`, which the `reviewers` rule replaced. A review block
 * pinned to a rung name is left as it is, and the drawing check names it when
 * no reviewer has that name.
 */
export const withReviewers = (pipeline: Pipeline): Pipeline => ({
  ...pipeline,
  nodes: pipeline.nodes.map((node) =>
    node.kind === "agent" && node.role === "review" && node.model === "above"
      ? { ...node, model: "reviewers" }
      : node,
  ),
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

const fileOf = <Old>(
  pipelines: { readonly [project: string]: Old },
  upgrade: (pipeline: Old) => Pipeline,
): PipelinesFile => ({
  version: 5,
  pipelines: Object.fromEntries(
    Object.entries(pipelines).map(([project, pipeline]) => [project, upgrade(pipeline)]),
  ),
});

const draftsOf = (
  drafts: typeof NamedDrafts.Type,
  upgrade: (pipeline: NamedPipeline) => Pipeline,
): DraftsFile => ({
  version: 3,
  drafts: Object.fromEntries(
    Object.entries(drafts).map(([project, draft]) => [
      project,
      { base: draft.base === null ? null : upgrade(draft.base), pipeline: upgrade(draft.pipeline) },
    ]),
  ),
});

/**
 * Converts one file through `rewrite`, so the write is the same atomic
 * replace every other writer of the file makes.
 */
const convertFile = <File, Encoded>(
  path: string,
  schema: S.Codec<File, Encoded>,
  upgrade: (
    text: string,
  ) => Effect.Effect<{ readonly from: string; readonly file: File }, S.SchemaError>,
  projectsOf: (file: File) => ReadonlyArray<string>,
  dryRun: boolean,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(text)) return { path, from: "none", projects: [] } satisfies CutoverReport;
    const upgraded = yield* upgrade(text.value);
    const report = {
      path,
      from: upgraded.from,
      projects: projectsOf(upgraded.file),
    } satisfies CutoverReport;
    if (dryRun || upgraded.from === "current") return report;
    const read = (at: string) =>
      fs.readFileString(at).pipe(
        Effect.flatMap((now) =>
          upgrade(now).pipe(
            Effect.map((again): Read<File> => ({
              value: again.file,
              error: undefined,
              text: now,
            })),
          ),
        ),
      );
    yield* rewrite(path, schema, read, (file) => file);
    return report;
  });
