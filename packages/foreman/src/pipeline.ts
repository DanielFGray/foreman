/**
 * A project's pipeline: the graph of blocks a task moves through, from the
 * queue to a landing.
 *
 * The graph has forward wires only. Work that goes back returns to the queue
 * with the evidence it earned (the rungs that failed it, its attempts), and
 * routers at the entry send it on by that evidence. A wire to "what runs after
 * a rejection" would be a pointer to what runs next, which goes stale when the
 * graph is edited; evidence does not.
 *
 * Nothing here stores where a task is. `place` replays the graph from a source
 * with the task's facts every time it is asked. A fact names a block by its
 * id, so a fact about a block the operator deleted places nothing, and the
 * task is placed by what remains. The editor keeps a block's id across edits
 * for the same reason.
 *
 * herdr-web's page imports this module and `pipeline-belt.ts` in the browser,
 * so neither may import, other than as a type, anything that reaches the task
 * store or the file system.
 */
import { Graph, Option, Schema as S } from "effect";
import type { TaskStatus } from "./prog.ts";
import { STEPS, type Step } from "./policy.ts";

/** Takes ready tasks in queue order that match its filter. */
export const SourceNode = S.Struct({
  kind: S.Literal("source"),
  id: S.String,
  filter: S.String,
  next: S.String,
});

/** Sends a task on by the first route whose filter it matches. */
export const RouterNode = S.Struct({
  kind: S.Literal("router"),
  id: S.String,
  routes: S.Array(S.Struct({ when: S.String, to: S.String })),
  else: S.String,
});

/** Holds a task before the next work block until the policy permits `step`. */
export const GateNode = S.Struct({
  kind: S.Literal("gate"),
  id: S.String,
  step: S.Literals(STEPS),
  next: S.String,
});

/**
 * Runs an agent on the task.
 *
 * `model` is `ladder` (an author on the cheapest rung above the task's
 * failures), `above` (a reviewer on the next rung above the author), or a rung
 * name, which pins the block to that rung. `slots` caps how many of this
 * block's tasks run at once, inside the fleet's own limit.
 */
export const AgentNode = S.Struct({
  kind: S.Literal("agent"),
  id: S.String,
  role: S.Literals(["author", "review"]),
  model: S.String,
  slots: S.optional(S.Int.check(S.isGreaterThan(0))),
  next: S.String,
});

/**
 * Runs `command` on the task's branch tip. It passes that one commit: a later
 * commit places the task at the check again.
 */
export const CheckNode = S.Struct({
  kind: S.Literal("check"),
  id: S.String,
  command: S.String,
  next: S.String,
});

/**
 * Makes the task's branch `foreman/<id>` from the trunk tip. It runs no agent,
 * and placement walks through it: the branch is made when the first agent
 * after it dispatches, and git's record of the branch is what says it passed.
 */
export const BranchNode = S.Struct({ kind: S.Literal("branch"), id: S.String, next: S.String });

/**
 * Checks the task's branch out in a directory of its own. Like a branch block
 * it runs no agent and is walked through. An agent after a branch with no
 * worktree works in the operator's checkout.
 */
export const WorktreeNode = S.Struct({
  kind: S.Literal("worktree"),
  id: S.String,
  next: S.String,
});

/** How a land block puts the approved commit onto the trunk. */
export const LANDINGS = ["merge", "fast-forward"] as const;
export type Landing = (typeof LANDINGS)[number];

/**
 * Proves and applies the task's branch to the project's checkout, which
 * completes it. `how` is `merge` (a merge commit) when absent.
 */
export const LandNode = S.Struct({
  kind: S.Literal("land"),
  id: S.String,
  how: S.optional(S.Literals(LANDINGS)),
});

/**
 * Completes the task with nothing to land: the end of a route with no branch,
 * whose author committed onto the operator's branch.
 */
export const DoneNode = S.Struct({ kind: S.Literal("done"), id: S.String });

/** Parks the task for the operator. */
export const ParkNode = S.Struct({ kind: S.Literal("park"), id: S.String });

export const PipelineNode = S.Union([
  SourceNode,
  RouterNode,
  GateNode,
  AgentNode,
  CheckNode,
  BranchNode,
  WorktreeNode,
  LandNode,
  DoneNode,
  ParkNode,
]);
export type PipelineNode = typeof PipelineNode.Type;
export type AgentNode = typeof AgentNode.Type;
export type CheckNode = typeof CheckNode.Type;
export type LandNode = typeof LandNode.Type;
export type DoneNode = typeof DoneNode.Type;

/** A block a task stops at: it runs something, or ends the task. The others decide at once. */
export type WorkNode = AgentNode | CheckNode | LandNode | DoneNode;

/**
 * Where the blocks before a work block put the task: `none` is the operator's
 * checkout on its own branch, `branch` the operator's checkout with the task's
 * branch out, `worktree` the task's branch in a directory of its own.
 */
export type Workspace = "none" | "branch" | "worktree";

export const Pipeline = S.Struct({ nodes: S.Array(PipelineNode) });
export type Pipeline = typeof Pipeline.Type;

/**
 * What placement and filters know about a task.
 *
 * Filters read these, never label strings, so a change in how a fact is
 * recorded changes `factsOf` alone.
 */
export interface Facts {
  readonly status: TaskStatus;
  readonly priority: number;
  readonly epic: string | undefined;
  /** 1 one file or rule, 2 one package, 3 crosses packages. */
  readonly size: number;
  /** The labels a person set on the task, such as `research`. */
  readonly labels: ReadonlySet<string>;
  /** The rungs that failed the task. */
  readonly failedBy: ReadonlySet<string>;
  /** Unfinished attempts recorded against any rung. */
  readonly attempts: number;
  /** The work blocks the task has passed since it last returned to the queue. */
  readonly passed: ReadonlySet<string>;
  /** A reviewer is at work on it. */
  readonly underReview: boolean;
  /** Its reviewer approved it, and settle has not yet recorded the review passed. */
  readonly approved: boolean;
}

/** How far a task's run at the block it stands at has gone. */
export type RunState =
  /** Nothing runs yet. The gates on the way decide when it may start. */
  | "waiting"
  /** The block's run is under way. */
  | "running"
  /** The run's advance signal is there and settle has not yet recorded it. */
  | "ended";

/** Where a task stands in a pipeline. */
export type Placement =
  /** No source takes the task, or its status puts it outside any flow. */
  | { readonly _tag: "Outside" }
  | { readonly _tag: "Parked"; readonly node: string }
  | {
      readonly _tag: "At";
      readonly node: WorkNode;
      readonly state: RunState;
      /** The gates between the last block it passed and this one. */
      readonly gates: ReadonlyArray<{ readonly id: string; readonly step: Step }>;
      /** Work blocks after this one, on the route its facts take now. */
      readonly ahead: number;
    };

/**
 * Where a task with these facts stands in `pipeline`.
 *
 * The walk starts at the first source whose filter matches and goes forward:
 * routers by the facts, past every work block the task has passed, and stops
 * at the first work block it has not. A task with work in flight and nothing
 * passed is placed by the same rule, because its status is the signal of the
 * block it is at: an `in_progress` task stands at the author block running,
 * and a `reviewing` one stands there ended until settle records the pass.
 */
export const place = (pipeline: Pipeline, facts: Facts): Placement => {
  if (facts.status !== "open" && facts.status !== "in_progress" && facts.status !== "reviewing") {
    return { _tag: "Outside" };
  }
  const nodes = indexOf(pipeline);
  const source = pipeline.nodes.find(
    (node) => node.kind === "source" && matches(facts, node.filter),
  );
  if (source === undefined) return { _tag: "Outside" };

  let gates: Array<{ id: string; step: Step }> = [];
  let node: PipelineNode | undefined = source;
  // Validation refuses a cycle, but placement may be asked about a pipeline
  // that was never validated, so the walk is bounded by the graph's size.
  for (let steps = 0; node !== undefined && steps <= pipeline.nodes.length; steps++) {
    switch (node.kind) {
      case "source":
        node = nodes.get(node.next);
        continue;
      case "gate":
        gates.push({ id: node.id, step: node.step });
        node = nodes.get(node.next);
        continue;
      case "router":
        node = nodes.get(routeOf(node, facts));
        continue;
      case "branch":
      case "worktree":
        node = nodes.get(node.next);
        continue;
      case "park":
        return { _tag: "Parked", node: node.id };
      case "agent":
      case "check":
      case "land":
      case "done":
        if (facts.passed.has(node.id)) {
          gates = [];
          node = "next" in node ? nodes.get(node.next) : undefined;
          continue;
        }
        return {
          _tag: "At",
          node,
          state: stateAt(node, facts),
          gates,
          ahead: aheadOf(nodes, node, facts, pipeline.nodes.length),
        };
    }
  }
  return { _tag: "Outside" };
};

/**
 * Where the task's route puts its agents, or nothing when no source takes it.
 *
 * Validation keeps every workspace block before the route's first agent, so
 * the answer holds for the whole route. The walk reads routers by the facts
 * and ignores what the task has passed, so it needs no branch tip: the tip is
 * read from the workspace this answers.
 */
export const routeWorkspace = (pipeline: Pipeline, facts: Facts): Workspace | undefined => {
  const nodes = indexOf(pipeline);
  let node: PipelineNode | undefined = pipeline.nodes.find(
    (candidate) => candidate.kind === "source" && matches(facts, candidate.filter),
  );
  if (node === undefined) return undefined;
  let workspace: Workspace = "none";
  for (let steps = 0; node !== undefined && steps <= pipeline.nodes.length; steps++) {
    switch (node.kind) {
      case "router":
        node = nodes.get(routeOf(node, facts));
        continue;
      case "branch":
      case "worktree":
        workspace = node.kind;
        node = nodes.get(node.next);
        continue;
      case "source":
      case "gate":
        node = nodes.get(node.next);
        continue;
      default:
        return workspace;
    }
  }
  return workspace;
};

/**
 * The first agent block of `role` on the task's route that the task has not
 * passed, or nothing when its route has none.
 *
 * This is where an agent the operator starts by hand runs. The operator can
 * start it before the task reaches that block, so each work block before it
 * on the route counts as passed.
 */
export const nextAgent = (
  pipeline: Pipeline,
  facts: Facts,
  role: AgentNode["role"],
): AgentNode | undefined => {
  let passed = facts.passed;
  for (let steps = 0; steps <= pipeline.nodes.length; steps++) {
    const placement = place(pipeline, { ...facts, passed });
    if (placement._tag !== "At") return undefined;
    const { node } = placement;
    if (node.kind === "agent" && node.role === role) return node;
    passed = new Set([...passed, node.id]);
  }
  return undefined;
};

/**
 * Why a pipeline cannot run, or nothing when it can.
 *
 * A pipeline that fails is not run at all: its project takes no step. It never
 * falls back to the standard pipeline, because running a flow the operator did
 * not draw is worse than stopping.
 *
 * Every block but land and park has a forward wire, so in a graph with no
 * cycle every route ends at a land or a park without a check of its own.
 */
export const problemsOf = (
  pipeline: Pipeline,
  rungs: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const shape = shapeProblems(pipeline, rungs);
  if (shape.length > 0) return shape;

  const wired = graphOf(pipeline);
  const cycle = Graph.findCycle(wired.graph);
  if (Option.isSome(cycle)) {
    const loop = cycle.value.path.map((index) => wired.idOf(index)).join(" → ");
    return [`the wires loop through ${loop}; work returns to the queue instead`];
  }

  const sources = pipeline.nodes.filter((node) => node.kind === "source");
  const work = pipeline.nodes.filter(isWork);
  const problems: Array<string> = [];

  for (const node of pipeline.nodes) {
    if (!sources.some((source) => wired.reaches(source.id, node.id))) {
      problems.push(`no source reaches ${node.id}`);
    }
  }

  const authors = work.filter(isRole("author"));
  const ends = work.filter((node) => node.kind === "land" || node.kind === "done");
  // Nothing skips review: no land or done after a source or an author but a reviewer.
  for (const [from, end] of skipping(pipeline, isRole("review"), [...sources, ...authors], ends)) {
    problems.push(`a route from ${from.id} reaches ${end.id} with no review after it`);
  }

  // A worktree checks out the task's branch, and a land merges it, so each
  // needs a branch made before it on every route.
  const isBranch = (node: PipelineNode) => node.kind === "branch";
  for (const [source, target] of skipping(
    pipeline,
    isBranch,
    sources,
    pipeline.nodes.filter((node) => node.kind === "worktree" || node.kind === "land"),
  )) {
    problems.push(`a route from ${source.id} reaches ${target.id} with no branch before it`);
  }
  // Every agent on a route works in one workspace, so a branch or a worktree
  // after an agent or a check would move the work away from the agent that
  // wrote it.
  for (const from of work.filter((node) => node.kind === "agent" || node.kind === "check")) {
    for (const block of pipeline.nodes.filter(
      (node) => node.kind === "branch" || node.kind === "worktree",
    )) {
      if (wired.reaches(from.id, block.id)) {
        problems.push(
          `a route from ${from.id} reaches ${block.id}: a route's workspace is set before its first agent`,
        );
      }
    }
  }
  // Work on a branch reaches the trunk only through a land, so a branch whose
  // route ends at done leaves the work on a branch nothing merges.
  for (const branch of pipeline.nodes.filter(isBranch)) {
    for (const done of work.filter((node) => node.kind === "done")) {
      if (wired.reaches(branch.id, done.id)) {
        problems.push(
          `a route from ${branch.id} ends at ${done.id}: work on this branch never lands`,
        );
      }
    }
  }
  // A check runs on the task's branch, and an open task has passed nothing, so
  // a check no author stands before has no branch to run on.
  for (const [source, check] of skipping(
    pipeline,
    isRole("author"),
    sources,
    work.filter((node) => node.kind === "check"),
  )) {
    problems.push(`a route from ${source.id} reaches ${check.id} with no author before it`);
  }

  // Every step that spends is one the policy can stop: with the gates taken
  // out, and the walk halted at each work block, the first work block after a
  // source or another work block must be out of reach.
  const ungated = graphOf(
    pipeline,
    (node) => node.kind !== "gate",
    (node) => !isWork(node),
  );
  const nodes = indexOf(pipeline);
  for (const from of [...sources, ...work]) {
    for (const { to } of wiresOf(from)) {
      if (nodes.get(to)?.kind === "gate") continue;
      for (const target of work) {
        if (ungated.reaches(to, target.id)) {
          problems.push(`a route from ${from.id} reaches ${target.id} through no gate`);
        }
      }
    }
  }

  return [...new Set(problems)];
};

/**
 * The routes from an origin to a target that pass no block `passes` names:
 * with those blocks taken out of the graph, each target still in reach of an
 * origin is one such route.
 */
const skipping = (
  pipeline: Pipeline,
  passes: (node: PipelineNode) => boolean,
  origins: ReadonlyArray<PipelineNode>,
  targets: ReadonlyArray<PipelineNode>,
): ReadonlyArray<readonly [PipelineNode, PipelineNode]> => {
  const without = graphOf(pipeline, (node) => !passes(node));
  return origins.flatMap((origin) =>
    targets
      .filter((target) => without.reaches(origin.id, target.id))
      .map((target) => [origin, target] as const),
  );
};

const isRole =
  (role: AgentNode["role"]) =>
  (node: PipelineNode): boolean =>
    node.kind === "agent" && node.role === role;

/**
 * The pipeline of a project that has drawn none: the task's branch in a
 * worktree of its own, then author, review, and a merge.
 *
 * The router sends a task with any recorded failure or attempt to the `climb`
 * gate, so a retry is governed by its own step, apart from a first try.
 */
export const STANDARD_PIPELINE: Pipeline = {
  nodes: [
    { kind: "source", id: "queue", filter: "", next: "branch" },
    { kind: "branch", id: "branch", next: "worktree" },
    { kind: "worktree", id: "worktree", next: "retry" },
    {
      kind: "router",
      id: "retry",
      routes: [
        { when: "failed", to: "climb" },
        { when: "attempts>=1", to: "climb" },
      ],
      else: "start",
    },
    { kind: "gate", id: "start", step: "author", next: "author" },
    { kind: "gate", id: "climb", step: "climb", next: "author" },
    { kind: "agent", id: "author", role: "author", model: "ladder", next: "review-gate" },
    { kind: "gate", id: "review-gate", step: "review", next: "review" },
    { kind: "agent", id: "review", role: "review", model: "above", next: "land-gate" },
    { kind: "gate", id: "land-gate", step: "land", next: "land" },
    { kind: "land", id: "land", how: "merge" },
  ],
};

/** The pipeline as a Mermaid flowchart, one arrow per wire. */
export const toMermaid = (pipeline: Pipeline): string =>
  Graph.toMermaid(graphOf(pipeline).graph, {
    direction: "LR",
    nodeLabel: describe,
    edgeLabel: (label) => label,
    nodeShape: (node) => SHAPES[node.kind],
  });

/**
 * Whether `facts` match every term of `filter`. An empty filter matches all.
 *
 * Terms: `label:<name>`, `epic:<id>`, `failed` (any rung failed it),
 * `failed:<rung>`, and `size`, `priority` or `attempts` compared with `<=`,
 * `>=` or `=` to a whole number. A leading `-` negates a term. A filter that
 * does not parse matches nothing; validation is where it is reported.
 */
export const matches = (facts: Facts, filter: string): boolean => {
  const parsed = parseFilter(filter);
  return (
    parsed._tag === "Parsed" && parsed.terms.every((term) => term.test(facts) !== term.negated)
  );
};

export const parseFilter = (
  filter: string,
):
  | { readonly _tag: "Parsed"; readonly terms: ReadonlyArray<Term> }
  | { readonly _tag: "Invalid"; readonly reason: string } => {
  const terms: Array<Term> = [];
  for (const word of filter.trim().split(/\s+/).filter(Boolean)) {
    const negated = word.startsWith("-");
    const test = termTest(negated ? word.slice(1) : word);
    if (test === undefined) {
      return { _tag: "Invalid", reason: `the filter term ${word} means nothing` };
    }
    terms.push({ negated, test });
  }
  return { _tag: "Parsed", terms };
};

/** One term of a filter, already parsed. */
type Term = { readonly negated: boolean; readonly test: (facts: Facts) => boolean };

const termTest = (term: string): Term["test"] | undefined => {
  if (term === "failed") return (facts) => facts.failedBy.size > 0;
  const [kind, ...rest] = term.split(":");
  const value = rest.join(":");
  if (value !== "") {
    switch (kind) {
      case "label":
        return (facts) => facts.labels.has(value);
      case "epic":
        return (facts) => facts.epic === value;
      case "failed":
        return (facts) => facts.failedBy.has(value);
    }
  }
  const compared = /^(size|priority|attempts)(<=|>=|=)(\d+)$/.exec(term);
  if (compared === null) return undefined;
  const [, field, op, raw] = compared;
  const bound = Number(raw);
  const read = (facts: Facts) =>
    field === "size" ? facts.size : field === "priority" ? facts.priority : facts.attempts;
  return (facts) => {
    const n = read(facts);
    return op === "<=" ? n <= bound : op === ">=" ? n >= bound : n === bound;
  };
};

/** The checks that need no walk: names, wires, filters and models. */
const shapeProblems = (pipeline: Pipeline, rungs: ReadonlyArray<string>): Array<string> => {
  const problems: Array<string> = [];
  const ids = new Set<string>();
  for (const node of pipeline.nodes) {
    if (ids.has(node.id)) problems.push(`two blocks are named ${node.id}`);
    ids.add(node.id);
  }
  if (!pipeline.nodes.some((node) => node.kind === "source")) {
    problems.push("no source takes tasks in");
  }
  for (const node of pipeline.nodes) {
    for (const { to } of wiresOf(node)) {
      if (!ids.has(to)) problems.push(`${node.id} is wired to ${to}, which is no block`);
    }
    for (const filter of filtersOf(node)) {
      const parsed = parseFilter(filter);
      if (parsed._tag === "Invalid") problems.push(`${node.id}: ${parsed.reason}`);
    }
    if (node.kind === "agent") problems.push(...modelProblems(node, rungs));
    if (node.kind === "check" && node.command.trim() === "") {
      problems.push(`${node.id}: a check runs a command, and it names none`);
    }
  }
  return problems;
};

const modelProblems = (node: AgentNode, rungs: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (node.model === "ladder") {
    return node.role === "author"
      ? []
      : [`${node.id}: a reviewer reads above its author, not from the ladder's foot`];
  }
  if (node.model === "above") {
    return node.role === "review" ? [] : [`${node.id}: an author has no author to read above`];
  }
  return rungs.includes(node.model) ? [] : [`${node.id}: ${node.model} is no rung on the ladder`];
};

/**
 * The pipeline as a directed graph of the blocks `keep` accepts, with the
 * wires out of each block `follow` accepts.
 */
const graphOf = (
  pipeline: Pipeline,
  keep: (node: PipelineNode) => boolean = () => true,
  follow: (node: PipelineNode) => boolean = () => true,
) => {
  const index = new Map<string, Graph.NodeIndex>();
  const graph = Graph.directed<PipelineNode, string>((mutable) => {
    for (const node of pipeline.nodes) {
      if (keep(node)) index.set(node.id, Graph.addNode(mutable, node));
    }
    for (const node of pipeline.nodes) {
      const from = index.get(node.id);
      if (from === undefined || !follow(node)) continue;
      for (const wire of wiresOf(node)) {
        const to = index.get(wire.to);
        if (to !== undefined) Graph.addEdge(mutable, from, to, wire.label);
      }
    }
  });
  return {
    graph,
    idOf: (at: Graph.NodeIndex) =>
      Option.match(Graph.getNode(graph, at), { onNone: () => `#${at}`, onSome: (node) => node.id }),
    reaches: (from: string, to: string): boolean => {
      const a = index.get(from);
      const b = index.get(to);
      return a !== undefined && b !== undefined && Graph.hasPath(graph, a, b);
    },
  };
};

const wiresOf = (node: PipelineNode): ReadonlyArray<{ to: string; label: string }> => {
  switch (node.kind) {
    case "source":
    case "gate":
    case "agent":
    case "check":
    case "branch":
    case "worktree":
      return [{ to: node.next, label: "" }];
    case "router":
      return [
        ...node.routes.map((route) => ({ to: route.to, label: route.when })),
        { to: node.else, label: "else" },
      ];
    case "land":
    case "done":
    case "park":
      return [];
  }
};

const filtersOf = (node: PipelineNode): ReadonlyArray<string> =>
  node.kind === "source"
    ? [node.filter]
    : node.kind === "router"
      ? node.routes.map((route) => route.when)
      : [];

const isWork = (node: PipelineNode): node is WorkNode =>
  node.kind === "agent" || node.kind === "check" || node.kind === "land" || node.kind === "done";

const indexOf = (pipeline: Pipeline): ReadonlyMap<string, PipelineNode> =>
  new Map(pipeline.nodes.map((node) => [node.id, node]));

const routeOf = (router: typeof RouterNode.Type, facts: Facts): string =>
  router.routes.find((route) => matches(facts, route.when))?.to ?? router.else;

/**
 * A check, a land and a done run inside one tick and leave no open run, so a
 * task at one is always waiting there.
 */
const stateAt = (node: WorkNode, facts: Facts): RunState => {
  if (node.kind !== "agent") return "waiting";
  if (node.role === "author") {
    return facts.status === "in_progress"
      ? "running"
      : facts.status === "reviewing"
        ? "ended"
        : "waiting";
  }
  return facts.approved ? "ended" : facts.underReview ? "running" : "waiting";
};

/** Work blocks after `from` on the route the facts take now. */
const aheadOf = (
  nodes: ReadonlyMap<string, PipelineNode>,
  from: WorkNode,
  facts: Facts,
  bound: number,
): number => {
  let count = 0;
  let node = "next" in from ? nodes.get(from.next) : undefined;
  for (let steps = 0; node !== undefined && steps <= bound; steps++) {
    switch (node.kind) {
      case "source":
      case "gate":
      case "branch":
      case "worktree":
        node = nodes.get(node.next);
        continue;
      case "router":
        node = nodes.get(routeOf(node, facts));
        continue;
      case "park":
        return count;
      case "land":
      case "done":
        return count + 1;
      case "agent":
      case "check":
        count++;
        node = nodes.get(node.next);
    }
  }
  return count;
};

const describe = (node: PipelineNode): string => {
  switch (node.kind) {
    case "source":
      return `${node.id}: ${node.filter === "" ? "all ready tasks" : node.filter}`;
    case "router":
      return node.id;
    case "gate":
      return `${node.id}: ${node.step}`;
    case "agent":
      return `${node.id}: ${node.role} on ${node.model}`;
    case "check":
      return `${node.id}: runs ${node.command}`;
    case "land":
      return `${node.id}: ${node.how ?? "merge"}`;
    case "branch":
    case "worktree":
    case "done":
    case "park":
      return node.id;
  }
};

const SHAPES: Record<PipelineNode["kind"], Graph.MermaidNodeShape> = {
  source: "stadium",
  router: "diamond",
  gate: "hexagon",
  agent: "rectangle",
  check: "rounded",
  branch: "cylindrical",
  worktree: "cylindrical",
  land: "subroutine",
  done: "subroutine",
  park: "circle",
};
