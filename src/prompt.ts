import { FileSystem, Path } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import template from "lodash/template.js";
import { labelFor } from "./fleet.ts";
import type { Item, ReadyTask } from "./prog.ts";

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
      /**
       * `reviewed` decides who lands the work, which is the one structural
       * difference between the two paths an author can take.
       */
      author: (task: ReadyTask, worktree: string, repository: string, reviewed: boolean) =>
        render("author", {
          task: task.id,
          title: task.title,
          project: task.project,
          worktree,
          repository,
          branch: labelFor(task.id),
          reviewed,
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

      review: (item: Item, worktree: string, repository: string) =>
        render("review", {
          task: item.id,
          title: item.title,
          project: item.project,
          worktree,
          branch: labelFor(item.id),
          repository,
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
