// A pretend task's walk through a pipeline, decided by the rules the
// dispatcher runs: each pretend event is folded with `stepOf` and `applyRow`
// over a task held in memory, and `place` reads where it stands after each.
// Nothing is read from or written to the store.
import { type BlockRung, rungAt } from "./agent-rung.ts";
import { wallAccountOf } from "./harness.ts";
import { providerOf } from "./ladder.ts";
import {
  type AgentNode,
  type CheckNode,
  type Pipeline,
  type Placement,
  place,
  QUEUE,
} from "./pipeline.ts";
import { factsOf } from "./pipeline-facts.ts";
import type { Item } from "./records.ts";
import { newRunFor } from "./run-record.ts";
import { applyRow, openAgentOf, type RunEvent, stepOf, type StepRules } from "./run-step.ts";

/** The task a trace pretends to run: what a filter or a router reads of it. */
export interface PretendTask {
  readonly labels: ReadonlyArray<string>;
  /** Written as the `size:N` label; none reads as 1. */
  readonly size: number | undefined;
  readonly priority: number;
  readonly parent: string | undefined;
}

/**
 * What the operator pretends happened at the block the task stands at, in the
 * words `offers` lists: `exit:<name>`, `stop`, and `wall` where one shows, at
 * an agent; `passed` or `failed` at a check; `landed`, `conflicted` or
 * `broke` at a land; and `landed` at a done.
 */
export type TraceEvent = string;

/** Where the task stands after the start or after one event, and what it may do next. */
export interface TraceStep {
  /** The event this step follows; none for the start. */
  readonly event: TraceEvent | undefined;
  readonly placement: Placement;
  /** The rung an agent block chose for its run; none away from an agent block. */
  readonly rung: BlockRung | undefined;
  /** Why the task is parked for the operator, which ends the trace. */
  readonly parked: string | undefined;
  /** The task's tip, made up: `c0` where its branch starts, then one more for each author handoff. */
  readonly tip: string;
  /** The gates and blocks the task stood at so far, in order. */
  readonly route: ReadonlyArray<string>;
  readonly offers: ReadonlyArray<TraceEvent>;
}

export interface Trace {
  readonly steps: ReadonlyArray<TraceStep>;
  /** The first event the block it reached does not offer; the trace stops before it. */
  readonly refused:
    | { readonly event: TraceEvent; readonly offers: ReadonlyArray<TraceEvent> }
    | undefined;
}

/** The facts a trace assumes, which the dispatcher reads from the world instead. */
export const TRACE_ASSUMES = {
  accounts:
    "Every account is funded. A rung on an account this task's own runs stopped on a usage wall stays off for it, as it does in the dispatcher.",
  gates: "Every gate is granted.",
} as const;

/**
 * Walks `task` through `rules.pipeline` with `events`, from scratch.
 *
 * After the start and after each event, an agent block the task waits at
 * opens a run on the rung `rungAt` picks, as a dispatch does. An event the
 * block does not offer stops the trace.
 */
export const traceOf = (
  input: PretendTask,
  events: ReadonlyArray<TraceEvent>,
  rules: TraceRules,
): Trace => {
  let task = pretend(input);
  let route: ReadonlyArray<string> = [];
  const steps: Array<TraceStep> = [];
  const settle = (event: TraceEvent | undefined) => {
    const settled = dispatched(task, rules);
    task = settled.task;
    route = routeAfter(route, settled.placement);
    const offers = task.parked === undefined ? offersAt(settled.placement, settled.rung) : [];
    steps.push({
      event,
      placement: settled.placement,
      rung: settled.rung,
      parked: task.parked,
      tip: task.tip,
      route,
      offers,
    });
    return offers;
  };

  let offers = settle(undefined);
  for (const event of events) {
    if (!offers.includes(event)) return { steps, refused: { event, offers } };
    task = afterEvent(task, place(rules.pipeline, factsOf(task, rules.pipeline)), event, rules);
    offers = settle(event);
  }
  return { steps, refused: undefined };
};

/** The rules a trace reads: a step's, with the drawing it walks. */
/** What `foreman pipeline trace` reads: the pretend task, and the events chosen so far. */
export interface TraceRequest {
  readonly task: PretendTask;
  readonly events: ReadonlyArray<TraceEvent>;
}

/** The pipelines a project could be traced through: its draft, if any, and the one it runs. */
export interface TraceSources {
  readonly draft: Pipeline | undefined;
  /** The pipeline the project runs, and whether the operator drew it or it is the standard one. */
  readonly live: { readonly pipeline: Pipeline; readonly drawn: boolean };
}

/**
 * The trace `foreman pipeline trace --json` prints: through the project's
 * draft when it has one, else the pipeline it runs. An absent value is `null`
 * and a chosen rung is named, so the pipeline pane reads plain JSON.
 */
export const traceReport = (
  project: string,
  request: TraceRequest,
  sources: TraceSources,
  rules: Omit<StepRules, "pipeline">,
) => {
  const pipeline = sources.draft ?? sources.live.pipeline;
  const traced = traceOf(request.task, request.events, { ...rules, pipeline });
  return {
    project,
    source: sources.draft !== undefined ? "draft" : sources.live.drawn ? "saved" : "standard",
    assumes: TRACE_ASSUMES,
    ladder: rules.ladder.map((rung) => rung.name),
    attemptsPerRung: rules.attemptsPerRung,
    steps: traced.steps.map(stepJson),
    refused: traced.refused ?? null,
  };
};

export type TraceReport = ReturnType<typeof traceReport>;

/** A trace step as JSON: an absent value is `null`, and a rung is named. */
const stepJson = (step: TraceStep) => ({
  event: step.event ?? null,
  placement: step.placement,
  rung:
    step.rung === undefined
      ? null
      : step.rung._tag === "Dispatch"
        ? { _tag: "Dispatch", name: step.rung.rung.name }
        : step.rung,
  parked: step.parked ?? null,
  tip: step.tip,
  route: step.route,
  offers: step.offers,
});

type TraceRules = StepRules & { readonly pipeline: Pipeline };

/** A task held in memory, which always has a tip: it is made up. */
type Pretend = Pick<
  Item,
  | "id"
  | "title"
  | "project"
  | "status"
  | "priority"
  | "parent"
  | "labels"
  | "runs"
  | "charges"
  | "parked"
> & { readonly tip: string };

const pretend = (task: PretendTask): Pretend => ({
  id: "trace",
  title: "a pretend task",
  project: "trace",
  status: "open",
  priority: task.priority,
  parent: task.parent,
  labels: task.size === undefined ? task.labels : [...task.labels, `size:${task.size}`],
  runs: [],
  charges: [],
  parked: undefined,
  tip: "c0",
});

/**
 * The task placed, after an agent block it waits at opens its run. A parked
 * task opens none: the dispatcher's plan skips it.
 */
const dispatched = (
  task: Pretend,
  rules: TraceRules,
): {
  readonly task: Pretend;
  readonly placement: Placement;
  readonly rung: BlockRung | undefined;
} => {
  const placement = place(rules.pipeline, factsOf(task, rules.pipeline));
  if (
    task.parked !== undefined ||
    placement._tag !== "At" ||
    placement.node.kind !== "agent" ||
    placement.state !== "waiting"
  ) {
    const open = placement._tag === "At" && placement.node.kind === "agent";
    return { task, placement, rung: open ? openRung(task, rules) : undefined };
  }
  const rung = rungAt(rules.ladder, placement.node, task, new Set());
  if (rung._tag !== "Dispatch") return { task, placement, rung };
  const started = folded(task, [startOf(task, placement.node, rung.rung)], rules);
  return {
    task: started,
    placement: place(rules.pipeline, factsOf(started, rules.pipeline)),
    rung,
  };
};

/** The rung of the task's open agent run, as a dispatch chose it. */
const openRung = (task: Pretend, rules: StepRules): BlockRung | undefined => {
  const name = openAgentOf(rules.pipeline, task)?.run.rung;
  const rung = rules.ladder.find((candidate) => candidate.name === name);
  return rung === undefined ? undefined : { _tag: "Dispatch", rung };
};

/** The event a dispatch at `block` makes: a reviewer reads the task's tip. */
const startOf = (task: Pretend, block: AgentNode, rung: StepRules["ladder"][number]): RunEvent => {
  const run = newRunFor({
    task,
    branch: `foreman/${task.id}`,
    harness: rung.harness,
    model: rung.model,
    rung: rung.name,
    provider: providerOf(rung),
    role: block.role,
    node: block.id,
    commit: block.role === "review" ? task.tip : undefined,
  });
  return block.role === "review" ? { _tag: "ReviewStarted", run } : { _tag: "AuthorStarted", run };
};

/** The task after `event` at the block it stands at, with the events settle would observe after it. */
const afterEvent = (
  task: Pretend,
  placement: Placement,
  event: TraceEvent,
  rules: TraceRules,
): Pretend => {
  if (placement._tag !== "At") return task;
  const { node } = placement;
  if (node.kind === "agent") return atAgent(task, node, event, rules);
  if (node.kind === "check") {
    const ending = event === "passed" ? "passed" : "failed";
    return folded(task, [checkedAt(task, node, ending)], rules);
  }
  return folded(task, [LANDINGS[event]!], rules);
};

/** What a land or a done block's outcome is, as a step names it. */
const LANDINGS: Readonly<Record<TraceEvent, RunEvent>> = {
  landed: { _tag: "Landed" },
  conflicted: { _tag: "Conflicted" },
  broke: { _tag: "Broke" },
};

/**
 * An agent's event: a stop or a wall as settle observes it, or an exit named
 * on the task's tip, an author's on a new made-up commit. Once its pane is
 * idle, an exit wired onward hands off; one wired to the queue returns the
 * review, or requeues the author.
 */
const atAgent = (task: Pretend, node: AgentNode, event: TraceEvent, rules: TraceRules): Pretend => {
  const ran = openAgentOf(rules.pipeline, task)?.run.rung;
  if (event === "stop") {
    const who = node.role === "review" ? `reviewer ${ran}` : (ran ?? "agent");
    return folded(task, [{ _tag: "Stalled", role: node.role, who }], rules);
  }
  if (event === "wall") return folded(task, [{ _tag: "Walled", role: node.role }], rules);
  const name = event.slice(EXIT.length);
  const exit = node.exits.find((candidate) => candidate.name === name);
  const tip = node.role === "author" ? `c${Number(task.tip.slice(1)) + 1}` : task.tip;
  const settled: RunEvent =
    exit?.to !== QUEUE
      ? { _tag: "HandedOff", tip }
      : node.role === "review"
        ? { _tag: "ReviewReturned" }
        : { _tag: "Requeued" };
  return folded({ ...task, tip }, [{ _tag: "ExitNamed", name, commit: tip }, settled], rules);
};

/** `task` after `events`, each written as the dispatcher writes it. */
const folded = (task: Pretend, events: ReadonlyArray<RunEvent>, rules: StepRules): Pretend =>
  events.reduce((before, next) => applyRow(before, stepOf(before, next, rules).row), task);

const EXIT = "exit:";

const checkedAt = (task: Pretend, block: CheckNode, ending: "passed" | "failed"): RunEvent => ({
  _tag: "Checked",
  block,
  check: {
    project: task.project,
    task: task.id,
    node: block.id,
    command: block.command,
    commit: task.tip,
    ending,
  },
});

/**
 * The events the block a task stands at offers, in the words a trace takes.
 * A wall is offered only where the dispatcher can see one (`wallAccountOf`).
 */
const offersAt = (placement: Placement, rung: BlockRung | undefined): ReadonlyArray<TraceEvent> => {
  if (placement._tag !== "At") return [];
  const { node, state } = placement;
  switch (node.kind) {
    case "agent": {
      if (state !== "running") return [];
      const named = rung?._tag === "Dispatch" && wallAccountOf(rung.rung) !== undefined;
      return [
        ...node.exits.map((exit) => `${EXIT}${exit.name}`),
        "stop",
        ...(named ? ["wall"] : []),
      ];
    }
    case "check":
      return ["passed", "failed"];
    case "land":
      return ["landed", "conflicted", "broke"];
    case "done":
      return ["landed"];
  }
};

/** `route` with the gates and the block of `placement`, where it moved on. */
const routeAfter = (route: ReadonlyArray<string>, placement: Placement): ReadonlyArray<string> => {
  const at =
    placement._tag === "At"
      ? [...placement.gates.map((gate) => gate.id), placement.node.id]
      : placement._tag === "Parked"
        ? [placement.node]
        : [];
  return at.length === 0 || route.at(-1) === at.at(-1) ? route : [...route, ...at];
};
