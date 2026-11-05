import { Option } from "effect";
import { isExit, type Run } from "tasks";
import { attemptsOf, failuresOf, type Item, valueOf } from "./records.ts";
import { exitAt, type Facts, type NamedExit, type Pipeline, QUEUE } from "./pipeline.ts";

/**
 * What placement knows about `item` in `pipeline`, read from its status,
 * labels, runs and charges. This is the one reader of runs for placement.
 *
 * A run stores the id of the exit it named; each named exit carries its name
 * as the drawing stands now, which filters read. The task's exits count from
 * the last time it left a source: a return to the queue starts the count
 * again. An exit the drawing lacks is no return: nothing says where it
 * led, so it stays, and placement asks the operator about it.
 */
export const factsOf = (
  item: Pick<Item, "status" | "priority" | "parent" | "labels" | "runs" | "charges" | "tip">,
  pipeline: Pipeline,
): Facts => {
  const open = item.runs.findLast((run) => run.open && run.role !== "check");
  const exits = item.runs.flatMap((run) => namedBy(run, pipeline));
  return {
    status: item.status,
    priority: item.priority,
    epic: Option.getOrUndefined(item.parent),
    size: sizeOf(item.labels),
    labels: new Set(item.labels),
    failedBy: new Set(failuresOf(item)),
    attempts: attemptCount(item),
    tip: item.tip,
    running: Option.fromNullishOr(open).pipe(
      Option.flatMap((run) =>
        Option.map(run.node, (node) => ({ node, named: Option.exists(run.ending, isExit) })),
      ),
      Option.getOrUndefined,
    ),
    named: sinceSource(exits, pipeline),
    exit: exits.at(-1)?.name,
  };
};

/** The exit a run named, if it named one at a block. */
const namedBy = (run: Run, pipeline: Pipeline): ReadonlyArray<NamedExit> =>
  Option.all({ node: run.node, id: Option.filter(run.ending, isExit) }).pipe(
    Option.map(({ node, id }) => ({
      node,
      id,
      name: exitAt(pipeline, node, id)?.name,
      commit: Option.getOrUndefined(run.commit),
    })),
    Option.toArray,
  );

/** The exits after the last one that sent the task back to its source. */
const sinceSource = (
  exits: ReadonlyArray<NamedExit>,
  pipeline: Pipeline,
): ReadonlyArray<NamedExit> => {
  const back = exits.findLastIndex((exit) => exitAt(pipeline, exit.node, exit.id)?.to === QUEUE);
  return exits.slice(back + 1);
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
    item.runs.flatMap((run) => (run.role === "author" ? Option.toArray(run.rung) : [])),
  );
  return [...rungs].reduce((sum, rung) => sum + attemptsOf(item, [rung]), 0);
};
