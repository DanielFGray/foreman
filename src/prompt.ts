import { FileSystem, Path } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import template from "lodash/template.js";
import { labelFor } from "./fleet.ts";
import type { DiagnosticIntent, Item, ReadyTask } from "./prog.ts";

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
export class Prompts extends Effect.Service<Prompts>()("Prompts", {
  dependencies: [BunContext.layer],
  accessors: true,
  effect: Effect.gen(function* () {
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
      author: (task: ReadyTask, worktree: string, repository: string) =>
        render("author", {
          task: task.id,
          title: task.title,
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
        base: string,
        verify: string | undefined,
      ) =>
        render("review", {
          task: item.id,
          title: item.title,
          project: item.project,
          worktree,
          branch: labelFor(item.id),
          repository,
          base,
          verification: verify
            ? `Foreman runs \`${verify}\` in ${repository} immediately before and after it merges this branch, and undoes a merge that turns a green checkout red. That is the mechanical gate and it does not need your help: do not spend a full suite run repeating it. Several agents share this machine, and a redundant run starves the ones doing new work.`
            : `Foreman lands this branch on git's exit code alone: ${item.project} names no verification command. The full run is yours — nothing downstream will do it.`,
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

      /**
       * Turns the rough plan (the epic's description) into a specification.
       * The agent works in a plan worktree and writes the spec back into the
       * epic's description, where the tasker and the fleet read it.
       */
      planner: (item: Item, worktree: string, repository: string) =>
        render("planner", {
          task: item.id,
          title: item.title,
          project: item.project,
          worktree,
          branch: labelFor(item.id),
          repository,
        }),

      /** Turns the specification into tasks filed under the plan epic. */
      tasker: (item: Item, worktree: string, repository: string) =>
        render("tasker", {
          task: item.id,
          title: item.title,
          project: item.project,
          worktree,
          branch: labelFor(item.id),
          repository,
        }),
    } as const;
  }),
}) {}

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
}) {}
