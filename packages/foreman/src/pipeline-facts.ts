import { isExit, type Run } from "tasks";
import { attemptsOf, failuresOf, type Item, valueOf } from "./records.ts";
import { type Facts, type NamedExit, type Pipeline, type PipelineNode, QUEUE } from "./pipeline.ts";

/**
 * What placement knows about `item` in `pipeline`, read from its status,
 * labels, runs and charges. This is the one reader of runs for placement.
 *
 * The task's exits count from the last time it left a source: a return to the
 * queue, or an exit the drawing no longer has, starts the count again, because
 * either sends the task back to its source.
 */
export const factsOf = (
  item: Pick<Item, "status" | "priority" | "parent" | "labels" | "runs" | "charges" | "tip">,
  pipeline: Pipeline,
): Facts => {
  const open = item.runs.findLast((run) => run.open && run.role !== "check");
  const exits = item.runs.flatMap((run) => namedBy(run));
  return {
    status: item.status,
    priority: item.priority,
    epic: item.parent,
    size: sizeOf(item.labels),
    labels: new Set(item.labels),
    failedBy: new Set(failuresOf(item)),
    attempts: attemptCount(item),
    tip: item.tip,
    running: open?.node === undefined ? undefined : { node: open.node, named: isExit(open.ending) },
    named: sinceSource(exits, pipeline),
    exit: exits.at(-1)?.name,
  };
};

/** The exit a run named, if it named one at a block. */
const namedBy = (run: Run): ReadonlyArray<NamedExit> =>
  run.node !== undefined && isExit(run.ending)
    ? [{ node: run.node, name: run.ending, commit: run.commit }]
    : [];

/** The exits after the last one that sent the task back to its source. */
const sinceSource = (
  exits: ReadonlyArray<NamedExit>,
  pipeline: Pipeline,
): ReadonlyArray<NamedExit> => {
  const nodes = new Map(pipeline.nodes.map((node) => [node.id, node]));
  const back = exits.findLastIndex((exit) => returns(nodes.get(exit.node), exit.name));
  return exits.slice(back + 1);
};

/** Whether naming `name` at `node` sends the task back to its source. */
const returns = (node: PipelineNode | undefined, name: string): boolean => {
  if (node?.kind !== "agent" && node?.kind !== "check") return true;
  const exit = node.exits.find((candidate) => candidate.name === name);
  return exit === undefined || exit.to === QUEUE;
};

const valuesOf = (labels: ReadonlyArray<string>, kind: string): ReadonlyArray<string> =>
  labels.flatMap((label) => {
    const value = valueOf(label, kind);
    return value === undefined ? [] : [value];
  });

/** From `size:N`; 1 when the task has none. */
const sizeOf = (labels: ReadonlyArray<string>): number => {
  const size = valuesOf(labels, "size").find((value) => /^\d+$/.test(value));
  return size === undefined ? 1 : Number(size);
};

/** Each rung's own attempt count (`attemptsOf`), summed over the rungs that authored the task. */
const attemptCount = (item: Pick<Item, "runs" | "charges">): number => {
  const rungs = new Set(
    item.runs.flatMap((run) => (run.role === "author" && run.rung !== undefined ? [run.rung] : [])),
  );
  return [...rungs].reduce((sum, rung) => sum + attemptsOf(item, [rung]), 0);
};
