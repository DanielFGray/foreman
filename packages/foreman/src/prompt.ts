import { BunServices } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import template from "lodash/template.js";
import { labelFor } from "./fleet.ts";
import { isSatisfied } from "./lap.ts";
import type { Workspace } from "./pipeline.ts";
import type { DiagnosticIntent, Item } from "./prog.ts";

/**
 * The messages workers receive, rendered from files under prompts/.
 *
 * A worker has no memory of foreman and no way to ask it anything, so a prompt
 * carries everything the agent needs and is the entire contract for what it
 * does. That makes the wording the most-tuned part of the system, which is why
 * it lives in editable files rather than in this source: templates are read at
 * dispatch time, so an edit takes effect on the next task without a restart.
 *
 * Set FOREMAN_PROMPTS to point at a different directory.
 */
export class Prompts extends Context.Service<Prompts>()("Prompts", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const directory = process.env["FOREMAN_PROMPTS"] ?? path.join(import.meta.dir, "..", "prompts");

    /**
     * Rendering fails loudly on a name the template references but the caller
     * did not supply — lodash throws a ReferenceError for it. Substituting
     * nothing would hand an agent a prompt with no working directory in it: a
     * degraded worker that still looks like it is running. A typo made while
     * tuning a prompt should stop the dispatch, not quietly weaken it.
     */
    const render = (name: string, values: Record<string, unknown>) =>
      fs.readFileString(path.join(directory, `${name}.md`)).pipe(
        Effect.mapError((cause) => new PromptError({ template: name, detail: String(cause) })),
        Effect.flatMap((body) =>
          Effect.try({
            try: () => template(body, DELIMITERS)(values).trim(),
            catch: (cause) => new PromptError({ template: name, detail: String(cause) }),
          }),
        ),
      );

    return {
      /**
       * `workspace` is where the task's route has it work, which decides
       * what the agent may do to the checkout and how it reads trunk. `base`
       * is where the checkout stood when a task on the operator's own branch
       * first started, which is the only way to name its work there.
       */
      author: (
        task: Item,
        worktree: string,
        repository: string,
        workspace: Workspace | undefined,
        base?: string,
      ) =>
        render("author", {
          workspace: workspace ?? "worktree",
          base,
          task: task.id,
          title: task.title,
          labels: task.labels,
          project: task.project,
          worktree,
          repository,
          branch: labelFor(task.id),
        }),

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

      /**
       * `verify` is the project's own verification command, and the reviewer is
       * told about it rather than told to run it. Foreman runs that command
       * either side of the merge, so a reviewer repeating it buys no signal —
       * while several agents sharing one machine each running a full suite buys
       * a real slowdown. A project that names none has no such gate, and there
       * the full run is the reviewer's.
       *
       * `base` is the commit the branch was cut from, and it is what keeps the
       * reviewer's every command inside its own worktree. The repository is
       * still named, because the reviewer has to know which project it is
       * reading, but nothing in the prompt runs anything there.
       */
      review: (
        item: Item,
        worktree: string,
        repository: string,
        workspace: Workspace | undefined,
        base: string,
        verify: string | undefined,
      ) =>
        render("review", {
          workspace: workspace ?? "worktree",
          task: item.id,
          title: item.title,
          labels: item.labels,
          satisfied: isSatisfied(item),
          project: item.project,
          worktree,
          branch: labelFor(item.id),
          repository,
          base,
          verification:
            workspace === "none"
              ? `This work is already on the operator's branch, and nothing verifies it after you: the full run is yours.`
              : verify
                ? `Foreman runs \`${verify}\` in ${repository} before and after it merges, and undoes a merge that turns it red, so do not spend a full suite run repeating it: other agents share this machine.`
                : `Foreman lands this branch on git's exit code alone: ${item.project} keeps no \`scripts/verify.sh\`. The full run is yours.`,
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
 * Jinja-style delimiters rather than lodash's ERB defaults. Prompts are prose
 * that people edit, and `{{ task }}` stays legible in a paragraph where
 * `<%= task %>` reads as markup that wandered in from somewhere else.
 */
const DELIMITERS = {
  interpolate: /\{\{([\s\S]+?)\}\}/g,
  evaluate: /\{%([\s\S]+?)%\}/g,
} as const;

export class PromptError extends Schema.TaggedError<PromptError>()("PromptError", {
  template: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `${this.template}: ${this.detail}`;
  }
}
