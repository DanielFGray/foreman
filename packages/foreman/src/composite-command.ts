import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Schema as S } from "effect";
import { type Composites, type CompositeDefinition, type Drawing } from "./pipeline.ts";
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
import { writtenDrawingOf, type Flow } from "./pipeline-layout.ts";
import { blockOf, choicesOf } from "./pipeline-belt.ts";
import { agentPrompt } from "./pipeline-prompt.ts";

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
  drawing: writtenDrawingOf({ nodes: definition.blocks }, composites, flow),
  choices: {
    ...choicesOf(composites),
    outs: definition.exits.map((exit) => ({ id: exit.id, name: exit.name })),
  },
  entries: definition.entries,
  draft: draft === undefined ? null : { base: draft.base, definition: draft.definition },
  live,
});

/**
 * What `foreman composite show --json` prints: the definition (its open draft
 * when one is open), layout, choices, entries, and the live stored definition.
 */
export const compositeShow = (input: { readonly name: string; readonly flow: Flow }) =>
  Effect.gen(function* () {
    const { file, draft, inProjectDraft } = yield* definitionNow(input.name);
    const live = file.composites[input.name];
    const definition = draft?.definition ?? live;
    if (definition === undefined) return yield* missingDefinition(input.name, inProjectDraft);
    const composites = {
      ...file.composites,
      ...(draft?.composites ?? {}),
      [input.name]: definition,
    };
    return shownDefinition(input.name, definition, composites, input.flow, draft, live ?? null);
  });

const show = Command.make("show", { name, json, flow }, ({ name, json, flow }) =>
  Effect.gen(function* () {
    const shown = yield* compositeShow({ name, flow });
    if (json) return yield* Console.log(JSON.stringify(shown, null, 2));
    yield* Console.log(
      shown.draft === null
        ? `${name} (${shown.definition.blocks.length} blocks, ${entriesText(shown.definition)}):`
        : `${name} has a draft open (${shown.definition.blocks.length} blocks, ${entriesText(shown.definition)}):`,
    );
    yield* Console.log(JSON.stringify(shown.definition, null, 2));
    if (shown.draft !== null) {
      yield* Console.log(`save with foreman composite save ${name}, or discard it`);
    }
  }),
).pipe(
  Command.withDescription(
    "Print a composite definition, or its open draft when one is open, as JSON with --json",
  ),
);

/**
 * Apply one change to a composite definition's draft (starting one from the
 * stored definition when none is open). Returns the draft view `show --json`
 * would print, with `added` naming a block the change inserted.
 */
export const compositeEdit = (input: {
  readonly name: string;
  readonly change: CompositeChange;
  readonly flow: Flow;
}) =>
  Effect.gen(function* () {
    const { file, draft: open, inProjectDraft } = yield* definitionNow(input.name);
    const draft = open ?? (yield* freshCompositeDraft(input.name, file, inProjectDraft));
    const composites = {
      ...file.composites,
      ...draft.composites,
      [input.name]: draft.definition,
    };
    const result = applyDefinitionChange(draft.definition, input.change, composites);
    if (result._tag === "Refused") return yield* new PipelineError({ detail: result.reason });
    const next: CompositeDraft = {
      ...draft,
      definition: result.definition,
      composites: { ...draft.composites, ...result.composites },
    };
    yield* updateCompositeDrafts(draftsPath(), (current) => ({ ...current, [input.name]: next }));
    const available = {
      ...file.composites,
      ...next.composites,
      [input.name]: next.definition,
    };
    return {
      ...shownDefinition(
        input.name,
        next.definition,
        available,
        input.flow,
        next,
        file.composites[input.name] ?? null,
      ),
      added: result.added ?? null,
    };
  });

const edit = Command.make(
  "edit",
  {
    name,
    change: Argument.String("change").pipe(
      Argument.withDescription(
        'One change as JSON, such as {"_tag":"SetEntry","id":"entry-review","block":"review"} or {"_tag":"Rejoin","wire":{"from":"review","port":"exit:approved"},"to":"out:exit-landable"}',
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
      const result = yield* compositeEdit({ name, change: decoded, flow });
      if (json) return yield* Console.log(JSON.stringify(result, null, 2));
      yield* Console.log(
        result.added === null
          ? `changed ${name}'s draft`
          : `added ${result.added} to ${name}'s draft`,
      );
    }),
).pipe(
  Command.withDescription(
    "Change a composite definition's draft, starting one from the definition in the pipelines file. The stored definition stays as it is until save",
  ),
);

/**
 * Check every project that uses a composite definition's draft, then write the
 * draft as the stored definition.
 */
export const compositeSave = (input: { readonly name: string }) =>
  Effect.gen(function* () {
    const { file, draft } = yield* definitionNow(input.name);
    if (draft === undefined) {
      return yield* new PipelineError({ detail: `${input.name} has no draft open` });
    }
    const live = file.composites[input.name] ?? null;
    if (!sameDefinition(draft.base, live)) {
      return yield* new PipelineError({
        detail: `${input.name} changed since this draft began: discard the draft and edit it again`,
      });
    }
    const taken = Object.keys(draft.composites).filter((one) => file.composites[one] !== undefined);
    if (taken.length > 0) {
      return yield* new PipelineError({
        detail: `cannot save composite ${input.name}:\n${taken
          .map((one) => `  a composite named ${one} now exists: rename it and save again`)
          .join("\n")}`,
      });
    }
    const written = { ...draft.composites, [input.name]: draft.definition };
    const dangling = Object.entries(written).flatMap(([one, definition]) =>
      entryProblems(one, definition),
    );
    if (dangling.length > 0) {
      return yield* new PipelineError({
        detail: `cannot save composite ${input.name}:\n${dangling.map((problem) => `  ${problem}`).join("\n")}`,
      });
    }
    const composites: Composites = {
      ...file.composites,
      ...written,
    };
    const broken = yield* projectsBrokenBy(file.pipelines, composites, input.name);
    if (broken.length > 0) {
      return yield* new PipelineError({
        detail: `saving ${input.name} would break:\n${broken
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
        [input.name]: draft.definition,
      },
    }));
    yield* updateCompositeDrafts(draftsPath(), ({ [input.name]: _saved, ...others }) => others);
    return input.name;
  });

const save = Command.make("save", { name }, ({ name }) =>
  Effect.gen(function* () {
    yield* compositeSave({ name });
    yield* Console.log(`${name} now uses its draft`);
  }),
).pipe(
  Command.withDescription(
    "Check every project that uses a composite definition's draft, then write the draft as the stored definition",
  ),
);

/** Drop a composite definition's draft; the stored definition stays as it is. */
export const compositeDiscard = (input: { readonly name: string }) =>
  updateCompositeDrafts(draftsPath(), ({ [input.name]: _dropped, ...others }) => others).pipe(
    Effect.as(input.name),
  );

const discard = Command.make("discard", { name }, ({ name }) =>
  Effect.gen(function* () {
    yield* compositeDiscard({ name });
    yield* Console.log(`${name} has no draft open`);
  }),
).pipe(
  Command.withDescription("Drop a composite definition's draft, and keep the stored definition"),
);

/**
 * The prompt an agent block of the definition (its open draft, else the
 * stored one) would send, by the block's id inside the definition. It renders
 * as `pipeline prompt` does, on the definition's own blocks.
 */
export const compositePrompt = (input: { readonly name: string; readonly block: string }) =>
  Effect.gen(function* () {
    const { file, draft, inProjectDraft } = yield* definitionNow(input.name);
    const definition = draft?.definition ?? file.composites[input.name];
    if (definition === undefined) return yield* missingDefinition(input.name, inProjectDraft);
    // A nested instance is not a block a prompt reads; its agents are named in its own definition.
    const nodes = definition.blocks.flatMap((one) => (one.kind === "composite" ? [] : [one]));
    return yield* agentPrompt(input.name, { nodes }, input.block, `composite ${input.name}`);
  });

const promptOf = Command.make(
  "prompt",
  { name, block: Argument.String("block") },
  ({ name, block }) =>
    compositePrompt({ name, block }).pipe(Effect.flatMap((text) => Console.log(text))),
).pipe(
  Command.withDescription(
    "Print the prompt an agent block of a composite definition's draft, else of the stored definition, would send a pretend task. Writes nothing",
  ),
);

export const compositeCommand = Command.make("composite", {}).pipe(
  Command.withDescription(
    `Edit composite definitions as drafts of their own (${pipelinesPath()}, ${draftsPath()})`,
  ),
  Command.withSubcommands([show, edit, promptOf, save, discard]),
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
    // A project draft's MakeComposite definitions are stored only when that project's draft is saved.
    const inProjectDraft = Object.values(drafts.drafts).some(
      (draft) => draft.composites[name] !== undefined,
    );
    return { file, draft: drafts.composites[name], inProjectDraft };
  });

const missingDefinition = (name: string, inProjectDraft: boolean) =>
  new PipelineError({
    detail: inProjectDraft
      ? `composite ${name} is made in a project draft: save that project's draft first`
      : `no composite named ${name}`,
  });

const freshCompositeDraft = (name: string, file: PipelinesFile, inProjectDraft: boolean) => {
  const live = file.composites[name];
  if (live === undefined) return Effect.fail(missingDefinition(name, inProjectDraft));
  return Effect.succeed<CompositeDraft>({
    base: live,
    definition: live,
    composites: {},
  });
};

const entriesText = (definition: CompositeDefinition) =>
  `entries ${definition.entries.map((entry) => `${entry.name} -> ${entry.block}`).join(", ")}`;

/**
 * A definition with no entry, or an entry that names no block of its own.
 * Checked on every save, because a project that does not use the definition
 * would otherwise store it unnoticed.
 */
const entryProblems = (name: string, definition: CompositeDefinition) =>
  definition.entries.length === 0
    ? [`${name}: the definition has no entry`]
    : definition.entries
        .filter((entry) => !definition.blocks.some((block) => block.id === blockOf(entry.block)))
        .map(
          (entry) =>
            `${name}: the entry ${entry.name} names ${entry.block}, which is no block of the definition`,
        );

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
