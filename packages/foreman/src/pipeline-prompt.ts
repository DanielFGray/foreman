import { Console, Effect } from "effect";
import { newWorkspace } from "./dispatcher.ts";
import { routeTarget, routeWorkspace, type Pipeline } from "./pipeline.ts";
import { PipelineError } from "./pipeline-error.ts";
import { factsOf } from "./pipeline-facts.ts";
import { pretend } from "./pipeline-trace.ts";
import { Prompts } from "./prompt.ts";

/**
 * Prints the prompt agent block `block` of `pipeline` would send. It goes
 * through `Prompts.agent`, as `foreman prompt` does for a real task; only the
 * inputs differ: a pretend task with no labels and no runs, on the workspace
 * its route opens, with example paths and an example verify script where a
 * dispatch reads the world. `where` names the pipeline or definition in the
 * refusal when the block is missing.
 */
export const printPrompt = (project: string, pipeline: Pipeline, block: string, where: string) =>
  Effect.gen(function* () {
    const node = pipeline.nodes.find((one) => one.id === block);
    if (node?.kind !== "agent")
      return yield* new PipelineError({ detail: `${where} has no agent block named ${block}` });
    const task = {
      ...pretend({ labels: [], size: undefined, priority: 2, parent: undefined }),
      project,
    };
    const workspace = routeWorkspace(pipeline, factsOf(task, pipeline));
    const repository = "<repository>";
    const text = yield* (yield* Prompts).agent(node, {
      task,
      worktree:
        newWorkspace(workspace, { name: project, directory: repository }, task.id) ?? repository,
      repository,
      workspace,
      base: "<base>",
      trunk: routeTarget(pipeline, factsOf(task, pipeline)) ?? "<trunk>",
      verify: "./scripts/verify.sh",
      pipeline,
    });
    yield* Console.log(text);
  }).pipe(Effect.provide(Prompts.Default));
