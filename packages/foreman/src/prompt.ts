import { BunServices } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { labelFor } from "./fleet.ts";
import { authorClaim } from "./lap.ts";
import {
  type AgentNode,
  claimOf,
  type Exit,
  instructionsOf,
  isInstructionsName,
  type Pipeline,
  placeholdersIn,
  QUEUE,
  type Workspace,
} from "./pipeline.ts";
import type { DiagnosticIntent, Item } from "./records.ts";
import { configDirectory } from "./shared-file.ts";

/**
 * The messages workers receive.
 *
 * A worker has no memory of foreman and no way to ask it anything, so a prompt
 * carries everything the agent needs. An agent block's prompt has four
 * sections: the task, the workspace, the operator's instructions for the
 * block, and the exits. Foreman makes the first, second and fourth from the
 * task and the drawing, so a change to the drawing changes the prompt; the
 * operator writes the third, which is the most-tuned text in the system.
 *
 * Instructions are files `<name>.md`, read at dispatch time so an edit takes
 * effect on the next task without a restart. A file in the operator's
 * `prompts/` directory, in foreman's config directory, wins over the one foreman
 * ships in `prompts/`.
 */
export class Prompts extends Context.Service<Prompts>()("Prompts", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packaged = path.join(import.meta.dir, "..", "prompts");
    const own = () => path.join(configDirectory(), "prompts");

    /**
     * The text of instructions `name`, or `undefined` when no directory has
     * it. A name outside a-z, 0-9 and - fails, since it could name a file
     * outside the directory.
     */
    const read = (name: string) =>
      Effect.gen(function* () {
        if (!isInstructionsName(name)) return yield* misnamed(name);
        for (const directory of [own(), packaged]) {
          const file = path.join(directory, `${name}.md`);
          if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) {
            return yield* fs
              .readFileString(file)
              .pipe(
                Effect.mapError(
                  (cause) => new PromptError({ template: name, detail: String(cause) }),
                ),
              );
          }
        }
        return undefined;
      });

    const render = (name: string, values: Values) =>
      Effect.gen(function* () {
        const body = yield* read(name);
        if (body === undefined) {
          return yield* new PromptError({ template: name, detail: `no file is named ${name}.md` });
        }
        return yield* fill(name, body, values);
      });

    return {
      read,

      /**
       * Writes `text` as instructions `name` in the operator's `prompts/`
       * directory, where it wins over the file foreman ships, and answers the
       * file's path. A dispatch reads the file, so the text goes to a temporary
       * file first and is renamed into place: no dispatch reads half of it.
       */
      write: (name: string, text: string) =>
        Effect.gen(function* () {
          if (!isInstructionsName(name)) return yield* misnamed(name);
          const directory = own();
          const file = path.join(directory, `${name}.md`);
          const temporary = path.join(directory, `.${name}.md.${process.pid}.tmp`);
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.writeFileString(temporary, text);
          yield* fs.rename(temporary, file);
          return file;
        }).pipe(
          Effect.catchTag("PlatformError", (cause) =>
            Effect.fail(new PromptError({ template: name, detail: String(cause) })),
          ),
        ),

      /**
       * The instructions each name reads, for validation. A name with no file,
       * or one that cannot be read, is absent: that stops the projects whose
       * blocks use it, not the whole reading.
       */
      instructions: (names: ReadonlyArray<string>) =>
        Effect.forEach(new Set(names), (name) =>
          read(name).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.map((text) => [name, text] as const),
          ),
        ).pipe(
          Effect.map(
            (pairs) =>
              new Map(
                pairs.flatMap(([name, text]) =>
                  text === undefined ? [] : [[name, text] as const],
                ),
              ),
          ),
        ),

      /** The full prompt for an agent block's run on a task. */
      agent: (block: AgentNode, run: AgentRun) =>
        render(instructionsOf(block), {
          task: run.task.id,
          branch: labelFor(run.task.id),
          base: run.base,
          worktree: run.worktree,
        }).pipe(
          Effect.map((instructions) =>
            [
              taskSection(block, run),
              workspaceSection(block, run),
              instructions,
              exitsSection(block, run),
            ]
              .map((section) => section.trim())
              .join("\n\n"),
          ),
        ),

      /**
       * Sends an agent into a checkout that is not foreman's, to preserve what
       * it finds. `repository` is that checkout: there is no worktree, because
       * the work being rescued exists only in the operator's own tree.
       */
      onboard: (item: Item, repository: string) =>
        render("onboard", {
          task: item.id,
          title: item.title,
          project: item.project,
          repository,
          branch: labelFor(item.id),
        }),

      diagnose: (item: Item, worktree: string, repository: string, intent: DiagnosticIntent) =>
        render("diagnose", {
          task: item.id,
          title: item.title,
          project: item.project,
          worktree,
          branch: labelFor(item.id),
          repository,
          intent,
          objective:
            intent === "review"
              ? "Review the work as it exists, including uncommitted edits. Determine what is sound, what is incomplete, and what prevents it from being ready for formal review."
              : "Diagnose why this attempt appears stuck. Identify the concrete blocker, failed assumption, missing information, or wrong direction that the next author must handle.",
        }),
    } as const;
  }),
}) {
  static readonly Default = Layer.effect(this, this.make).pipe(Layer.provide(BunServices.layer));
}

/**
 * What one agent run works on. `workspace` decides what the agent may do to
 * the checkout and how it reads trunk; with none, the task works in a
 * worktree, as in the standard pipeline. `base` is the commit the work
 * starts from, the only way to name the work on the operator's own branch.
 * `trunk` is the branch the work lands on, which the agent reads trunk from.
 * `verify` is the project's own verification command, which a reviewer is
 * told about.
 */
export interface AgentRun {
  readonly task: Pick<Item, "id" | "title" | "project" | "labels" | "runs">;
  readonly worktree: string;
  readonly repository: string;
  readonly workspace: Workspace | undefined;
  readonly base: string;
  readonly trunk: string;
  readonly verify?: string | undefined;
  /** The pipeline the task runs, which says whether its author made a claim; absent when its project runs none. */
  readonly pipeline: Pipeline | undefined;
}

type Values = Readonly<Record<string, string>>;

const misnamed = (name: string) =>
  new PromptError({ template: name, detail: `${name} is no file name: use a-z, 0-9 and -` });

/**
 * Replaces each `{{ name }}` in `body` with its value. A name with no entry
 * in `values` fails the render: substituting nothing would hand an agent a
 * prompt with a hole in it, a degraded worker that still looks like it is
 * running.
 */
const fill = (name: string, body: string, values: Values) =>
  Effect.gen(function* () {
    for (const placeholder of placeholdersIn(body)) {
      if (!(placeholder in values)) {
        return yield* new PromptError({
          template: name,
          detail: `{{ ${placeholder} }} is no placeholder: use ${Object.keys(values).join(", ")}`,
        });
      }
    }
    return body.replace(/\{\{\s*(.*?)\s*\}\}/g, (_, key: string) => values[key] ?? "").trim();
  });

/**
 * The task, and the two rare cases that change what the agent delivers. Each
 * reaches only the runs whose task calls for it, so every other prompt stays
 * short.
 */
const taskSection = (block: AgentNode, { task, workspace, pipeline, trunk }: AgentRun): string => {
  const lines = [
    "## Task",
    "",
    `${task.id} — ${task.title}`,
    `Project: ${task.project}. Read the task with \`foreman show ${task.id}\`; the project's backlog is \`foreman list -p ${task.project}\`.`,
  ];
  const research = task.labels.includes("research");
  if (block.role === "author" && research) {
    lines.push(
      "",
      `This task is labelled \`research\`: the deliverable is a report, not code. Write it to \`foreman log ${task.id} -\` with the commands you ran and what they showed, so a reviewer can check every claim. Make no commits of your own.${workspace === "none" ? "" : " The branch stays empty."}`,
    );
  }
  const claim = pipeline === undefined ? undefined : authorClaim(task, pipeline);
  if (block.role === "review" && claim !== undefined) {
    lines.push(
      "",
      `The author ended its run \`${claim.name}\`: it claims trunk (\`${trunk}\`) already does what the task asks. Walk the definition of done and find the code and tests on ${trunk} for each part. Approve only when every part is there; otherwise log the missing parts and return it.`,
    );
  }
  if (block.role === "review" && research) {
    lines.push(
      "",
      "This task is labelled `research`: the deliverable is the report in its log. Verify the evidence it cites against the definition of done. A partly answered report is a rejection.",
    );
  }
  return lines.join("\n");
};

/**
 * Where the agent works, what it must not do there, how it reads its work,
 * and what foreman does after an approval. A reviewer in a worktree is kept
 * out of the operator's checkout entirely: its git there collides with a
 * landing mid-merge.
 */
const workspaceSection = (block: AgentNode, run: AgentRun): string => {
  const { task, worktree, repository, workspace, base, trunk } = run;
  const branch = labelFor(task.id);
  const author = block.role === "author";
  const branchLine =
    workspace === "none"
      ? `Branch: the operator's own branch; the work is every commit after ${base}`
      : `Branch: ${branch}`;
  const rule =
    workspace === "none"
      ? author
        ? `Work only in ${worktree}, on the branch it has out. This is the operator's own checkout and branch, and no other agent or landing runs here until this task ends. Commit here; foreman lands nothing, because your commits are already on the operator's branch. Never switch branches, and never stash, reset or clean: a returned review is fixed by new commits, not by undoing old ones.`
        : `Run every command in ${worktree}: the operator's own checkout and branch, where the author committed. Nothing else runs here until this task ends. Never switch branches, and never stash, reset or clean: the commits are already on the operator's branch, so a return asks for new commits, never an undo. Do not read another task's worktree.`
      : workspace === "branch"
        ? author
          ? `Work only in ${worktree}, on ${branch}. This is the operator's own checkout, put on your branch for this task; no other agent or landing runs here until it lands. Never switch branches, and never stash, reset or clean: foreman checks the operator's branch out again when it lands, from a clean tree. To see trunk, use \`git log ${trunk}\` and \`git diff ${trunk}...HEAD\`.`
          : `Run every command in ${worktree}: the operator's own checkout, which has the task's branch out. No landing runs here until this task lands. Never switch branches, and never stash, reset or clean. Do not read another task's worktree.`
        : author
          ? `Work only in ${worktree}, on ${branch}. Never enter ${repository} or switch branches, and do not read another task's worktree. To see trunk, use \`git log ${trunk}\` and \`git diff ${trunk}...HEAD\` from here.`
          : `Run every command in ${worktree}. Never run git in ${repository}: foreman merges there, and a git command of yours mid-merge fails the landing. Do not read another task's worktree.`;
  const work = `Your task's work: \`git log ${base}..HEAD\` and \`git diff ${base} HEAD\`.`;
  const landing =
    workspace === "none"
      ? "After an approval foreman completes the task; do not mark it done."
      : "After an approval foreman merges and completes the task; do not merge and do not mark it done.";
  const lines = [
    "## Workspace",
    "",
    `Working directory: ${worktree}`,
    branchLine,
    `Repository checkout: ${repository}`,
    "",
    `- ${rule}`,
    `- ${work}`,
    `- ${landing}`,
  ];
  if (!author) lines.push(`- ${verification(run)}`);
  return lines.join("\n");
};

/**
 * Foreman runs the project's verification either side of the merge, so a
 * reviewer repeating it buys no signal, while several agents on one machine
 * each running a full suite buys a real slowdown. Where nothing verifies
 * after the reviewer, the full run is the reviewer's.
 */
const verification = ({ task, repository, workspace, verify }: AgentRun): string =>
  workspace === "none"
    ? "This work is already on the operator's branch, and nothing verifies it after you: the full run is yours."
    : verify
      ? `Foreman runs \`${verify}\` in ${repository} before and after it merges, and undoes a merge that turns it red, so do not spend a full suite run repeating it: other agents share this machine.`
      : `Foreman lands this branch on git's exit code alone: ${task.project} keeps no \`scripts/verify.sh\`. The full run is yours.`;

/**
 * One line per exit the block declares, then what follows when the agent
 * names none. This is the only text an agent block's prompt uses to name an
 * exit: the instructions foreman ships for agent blocks name none, so a drawing that renames or removes one cannot
 * leave them contradicting it. An author block that declares a claim exit
 * (`empty: claim`) is also told when to name it, under its name as drawn.
 */
const exitsSection = (block: AgentNode, { task }: AgentRun): string => {
  const claim = claimOf(block);
  return [
    "## Exits",
    "",
    "End your run by naming one exit:",
    "",
    ...block.exits.map((exit) => `- \`foreman exit ${task.id} ${exit.name}\`: ${whereTo(exit)}`),
    "",
    `Name exactly one exit; a second replaces the first. If you name none, the task ${block.stopped === "park" ? "parks" : "retries"}.`,
    ...(claim === undefined
      ? []
      : [
          "",
          `Name \`${claim.name}\` only when trunk already does everything the task asks: first prove it part by part in \`foreman log ${task.id} -\` (code, tests, commits). A reviewer reads the claim. Partly done is not done, and a claim you cannot point at line by line is rejected.`,
        ]),
  ].join("\n");
};

const whereTo = (exit: Exit): string => {
  const charge =
    exit.fails === "author"
      ? ", and the author's model is charged with a failure"
      : exit.fails === "self"
        ? ", and your model is charged with a failure"
        : "";
  return exit.to === QUEUE
    ? `the task returns to the queue${charge}.`
    : `the task goes to ${exit.to}${charge}.`;
};

export class PromptError extends Schema.TaggedError<PromptError>()("PromptError", {
  template: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `${this.template}: ${this.detail}`;
  }
}
