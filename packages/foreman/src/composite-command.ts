import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Schema as S } from "effect";
import {
  AgentNode,
  type Composites,
  type CompositeDefinition,
  type Drawing,
  LANDINGS,
} from "./pipeline.ts";
import { applyDefinitionChange, CompositeChange } from "./pipeline-edit.ts";
import {
  type CompositeDraft,
  draftsPath,
  readDraftsFile,
  sameDefinition,
  updateCompositeDrafts,
} from "./pipeline-draft.ts";
import { pipelinesNow, problemsOfDrawing } from "./pipeline-check.ts";
import { pipelinesPath, updatePipelinesFile, type PipelinesFile } from "./pipeline-file.ts";
import { PipelineError } from "./pipeline-error.ts";
import { drawingOf, type Flow } from "./pipeline-layout.ts";
import { INSERTABLE } from "./pipeline-belt.ts";
import { STEPS } from "./policy.ts";

/**
 * `foreman composite`: edit a composite definition as a draft of its own
 * (`docs/composite-blocks.md`).
 */

const name = Argument.String("name").pipe(
  Argument.withDescription("The composite definition to edit, save, discard or show"),
);
const json = Flag.Boolean("json").pipe(Flag.withDefault(false));
const flow = Flag.Literals("flow", ["across", "down"]).pipe(
  Flag.withDefault("across"),
  Flag.withDescription(
    "Which way the JSON drawing runs: across (left to right) or down (top to bottom)",
  ),
);

/** What the pane offers while editing a definition: built-in kinds, nested definitions, and the open ends it may wire to. */
const choicesOf = (composites: Composites, definition: CompositeDefinition) => ({
  insertable: INSERTABLE.filter((kind) => kind !== "composite"),
  composites: Object.keys(composites).sort(),
  outs: definition.exits.map((exit) => ({ id: exit.id, name: exit.name })),
  steps: STEPS,
  roles: AgentNode.fields.role.literals,
  landings: LANDINGS,
});

/** A definition as the pane draws and edits it: its blocks, open ends, and layout. */
const shownDefinition = (
  name: string,
  definition: CompositeDefinition,
  composites: Composites,
  flow: Flow,
  draft: CompositeDraft | undefined,
  live: CompositeDefinition | null,
) => ({
  name,
  definition,
  pipeline: { nodes: definition.blocks },
  drawing: drawingOf({ nodes: definition.blocks }, flow),
  choices: choicesOf(composites, definition),
  entry: definition.entry,
  draft: draft === undefined ? null : { base: draft.base, definition: draft.definition },
  live,
});

const show = Command.make("show", { name, json, flow }, ({ name, json, flow }) =>
  Effect.gen(function* () {
    const { file, draft } = yield* definitionNow(name);
    const live = file.composites[name];
    const definition = draft?.definition ?? live;
    if (definition === undefined) {
      return yield* new PipelineError({ detail: `no composite named ${name}` });
    }
    if (json) {
      const composites = {
        ...file.composites,
        ...(draft?.composites ?? {}),
        [name]: definition,
      };
      return yield* Console.log(
        JSON.stringify(
          shownDefinition(name, definition, composites, flow, draft, live ?? null),
          null,
          2,
        ),
      );
    }
    yield* Console.log(
      draft === undefined
        ? `${name} (${definition.blocks.length} blocks, entry ${definition.entry}):`
        : `${name} has a draft open (${definition.blocks.length} blocks, entry ${definition.entry}):`,
    );
    yield* Console.log(JSON.stringify(definition, null, 2));
    if (draft !== undefined) {
      yield* Console.log(`save with foreman composite save ${name}, or discard it`);
    }
  }),
).pipe(
  Command.withDescription(
    "Print a composite definition, or its open draft when one is open, as JSON with --json",
  ),
);

const edit = Command.make(
  "edit",
  {
    name,
    change: Argument.String("change").pipe(
      Argument.withDescription(
        'One change as JSON, such as {"_tag":"SetEntry","entry":"review"} or {"_tag":"Rejoin","wire":{"from":"review","port":"exit:approved"},"to":"out:exit-landable"}',
      ),
    ),
    json,
    flow,
  },
  ({ name, change, json, flow }) =>
    Effect.gen(function* () {
      const decoded = yield* S.decodeEffect(S.fromJsonString(CompositeChange))(change).pipe(
        Effect.mapError(
          (error) => new PipelineError({ detail: `that change cannot be read: ${error.message}` }),
        ),
      );
      const { file, draft: open } = yield* definitionNow(name);
      const draft = open ?? (yield* freshCompositeDraft(name, file));
      const composites = {
        ...file.composites,
        ...draft.composites,
        [name]: draft.definition,
      };
      const result = applyDefinitionChange(draft.definition, decoded, composites);
      if (result._tag === "Refused") return yield* new PipelineError({ detail: result.reason });
      const next: CompositeDraft = {
        ...draft,
        definition: result.definition,
        composites: { ...draft.composites, ...result.composites },
      };
      yield* updateCompositeDrafts(draftsPath(), (current) => ({ ...current, [name]: next }));
      if (json) {
        const available = {
          ...file.composites,
          ...next.composites,
          [name]: next.definition,
        };
        return yield* Console.log(
          JSON.stringify(
            {
              ...shownDefinition(
                name,
                next.definition,
                available,
                flow,
                next,
                file.composites[name] ?? null,
              ),
              added: result.added ?? null,
            },
            null,
            2,
          ),
        );
      }
      yield* Console.log(
        result.added === undefined
          ? `changed ${name}'s draft`
          : `added ${result.added} to ${name}'s draft`,
      );
    }),
).pipe(
  Command.withDescription(
    "Change a composite definition's draft, starting one from the definition in the pipelines file. The stored definition stays as it is until save",
  ),
);

const save = Command.make("save", { name }, ({ name }) =>
  Effect.gen(function* () {
    const { file, draft } = yield* definitionNow(name);
    if (draft === undefined) {
      return yield* new PipelineError({ detail: `${name} has no draft open` });
    }
    const live = file.composites[name] ?? null;
    if (!sameDefinition(draft.base, live)) {
      return yield* new PipelineError({
        detail: `${name} changed since this draft began: discard the draft and edit it again`,
      });
    }
    const taken = Object.keys(draft.composites).filter((one) => file.composites[one] !== undefined);
    if (taken.length > 0) {
      return yield* new PipelineError({
        detail: `cannot save composite ${name}:\n${taken
          .map((one) => `  a composite named ${one} now exists: rename it and save again`)
          .join("\n")}`,
      });
    }
    const composites: Composites = {
      ...file.composites,
      ...draft.composites,
      [name]: draft.definition,
    };
    const broken = yield* projectsBrokenBy(file.pipelines, composites, name);
    if (broken.length > 0) {
      return yield* new PipelineError({
        detail: `saving ${name} would break:\n${broken
          .map(({ project, problems }) =>
            [`  ${project}:`, ...problems.map((problem) => `    ${problem}`)].join("\n"),
          )
          .join("\n")}`,
      });
    }
    yield* updatePipelinesFile(pipelinesPath(), (current) => ({
      pipelines: current.pipelines,
      composites: {
        ...current.composites,
        ...draft.composites,
        [name]: draft.definition,
      },
    }));
    yield* updateCompositeDrafts(draftsPath(), ({ [name]: _saved, ...others }) => others);
    yield* Console.log(`${name} now uses its draft`);
  }),
).pipe(
  Command.withDescription(
    "Check every project that uses a composite definition's draft, then write the draft as the stored definition",
  ),
);

const discard = Command.make("discard", { name }, ({ name }) =>
  Effect.gen(function* () {
    yield* updateCompositeDrafts(draftsPath(), ({ [name]: _dropped, ...others }) => others);
    yield* Console.log(`${name} has no draft open`);
  }),
).pipe(
  Command.withDescription("Drop a composite definition's draft, and keep the stored definition"),
);

export const compositeCommand = Command.make("composite", {}).pipe(
  Command.withDescription(
    `Edit composite definitions as drafts of their own (${pipelinesPath()}, ${draftsPath()})`,
  ),
  Command.withSubcommands([show, edit, save, discard]),
);

const draftsFileNow = Effect.gen(function* () {
  const read = yield* readDraftsFile(draftsPath());
  if (read.error !== undefined) return yield* new PipelineError({ detail: read.error });
  return read.value;
});

const definitionNow = (name: string) =>
  Effect.gen(function* () {
    const file = yield* pipelinesNow;
    const drafts = yield* draftsFileNow;
    return { file, draft: drafts.composites[name] };
  });

const freshCompositeDraft = (name: string, file: PipelinesFile) => {
  const live = file.composites[name];
  if (live === undefined) {
    return Effect.fail(new PipelineError({ detail: `no composite named ${name}` }));
  }
  return Effect.succeed<CompositeDraft>({
    base: live,
    definition: live,
    composites: {},
  });
};

/**
 * Projects that use `name` (directly or through another definition) whose
 * expansion or ladder check fails with these definitions. A definition save
 * names each one and its problems.
 */
const projectsBrokenBy = (
  pipelines: PipelinesFile["pipelines"],
  composites: Composites,
  name: string,
) =>
  Effect.gen(function* () {
    const broken: Array<{ project: string; problems: ReadonlyArray<string> }> = [];
    for (const [project, drawing] of Object.entries(pipelines)) {
      if (!referencesDefinition(drawing, name, composites)) continue;
      const problems = yield* problemsOfDrawing(drawing, composites);
      if (problems.length > 0) broken.push({ project, problems });
    }
    return broken;
  });

/** Whether a drawing reaches `name` through an instance, directly or nested. */
const referencesDefinition = (
  drawing: Drawing,
  name: string,
  composites: Composites,
  seen: ReadonlySet<string> = new Set(),
): boolean => {
  for (const node of drawing.nodes) {
    if (node.kind !== "composite") continue;
    if (node.of === name) return true;
    if (seen.has(node.of)) continue;
    const nested = composites[node.of];
    if (nested === undefined) continue;
    if (
      referencesDefinition({ nodes: nested.blocks }, name, composites, new Set(seen).add(node.of))
    ) {
      return true;
    }
  }
  return false;
};
