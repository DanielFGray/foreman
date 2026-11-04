/**
 * A project's pipeline: the graph of blocks a task moves through, from the
 * queue to a landing.
 *
 * An agent or a check ends its run by naming an exit, and each exit is a wire
 * to the block that comes next, or to `queue`: a return, which sends the task
 * back to wait in priority order with the evidence it earned (the rungs that
 * failed it, its attempts). Routers at the entry send it on by that evidence.
 * An exit may wire back to an earlier block, so the graph may hold cycles;
 * validation refuses a cycle that cannot end.
 *
 * Nothing here stores where a task is. `place` reads the task's last exit and
 * walks its wire as the drawing stands now, so an edit to a wire moves the
 * task. A run stores the id of the block it ran at and the id of the exit it
 * named, never a name, so a rename moves nothing. An exit the drawing no longer
 * has, or one at a block it no longer has, places the task nowhere: where it
 * goes then is the operator's decision. The editor keeps a block's id and an
 * exit's id across edits for the same reason.
 *
 * herdr-web's page imports this module and `pipeline-belt.ts` in the browser,
 * so neither may import, other than as a type, anything that reaches the task
 * store or the file system.
 */
import { Graph, Option, Schema as S } from "effect";
import { PROCESS_ENDINGS } from "tasks/endings";
import type { TaskStatus } from "./records.ts";
import { mayAuthor } from "./ladder.ts";
import type { Seats } from "./reviewers.ts";
import { STEPS, type Step } from "./policy.ts";

/** The `to` of an exit that returns the task to the queue. */
export const QUEUE = "queue";

/**
 * A way to end a run, wired to the block that comes next, or to `queue`.
 *
 * `id` is the exit's identity: a run that names the exit stores it, and
 * placement looks it up. It is never reused within the pipeline. `name` is the
 * word an agent types and the pane shows, so a rename changes the name alone.
 * A check's exits are `passed` and `failed`, as id and name, because foreman
 * names them.
 *
 * `fails` charges a rung when the exit is named: `author` the rung of the
 * task's last author run, `self` the rung of the author block that named it.
 * A reviewer is no rung, so a review block names only `author`.
 *
 * `empty` says what an empty branch handed over with this exit means. `claim`
 * is the author's claim that trunk already does what the task asks: the empty
 * branch goes to a reviewer, who checks the claim (`authorClaim` in
 * `src/lap.ts`). Without it, an empty branch is unfinished work.
 */
export const Exit = S.Struct({
  id: S.String,
  name: S.String,
  to: S.String,
  fails: S.optional(S.Literals(["author", "self"])),
  empty: S.optional(S.Literal("claim")),
});
export type Exit = typeof Exit.Type;

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
 * `model` is, for an author, `ladder` (an author-enabled rung of the lowest
 * level above the task's failures, the peer that started least recently) or a
 * rung name that allows authoring; for a reviewer, `reviewers` (the reviewer
 * that read least recently, off a spent account, preferring a model other than
 * the author's) or the name of one reviewer. `slots` caps how many of this block's
 * tasks run at once, inside the fleet's own limit. `exits` are the names the
 * agent may end its run with. `stopped` is what follows a run that named none:
 * `retry` (the default) keeps the task at the block, and the model rule picks
 * the next rung or reviewer; `park` parks it. `instructions` names the operator's text for
 * the agent, a file `<name>.md`; it defaults to the role.
 */
export const AgentNode = S.Struct({
  kind: S.Literal("agent"),
  id: S.String,
  role: S.Literals(["author", "review"]),
  model: S.String,
  instructions: S.optional(S.String),
  slots: S.optional(S.Int.check(S.isGreaterThan(0))),
  exits: S.Array(Exit),
  stopped: S.optional(S.Literals(["retry", "park"])),
});

/**
 * Runs `command` on the task's branch tip, and names `passed` or `failed` by
 * its exit status. It passes that one commit: a later commit places the task
 * at the check again.
 */
export const CheckNode = S.Struct({
  kind: S.Literal("check"),
  id: S.String,
  command: S.String,
  exits: S.Array(Exit),
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

/**
 * How a land block puts the approved commit onto the trunk. `pull-request`
 * pushes it, opens a pull request on GitHub and merges that
 * (docs/issue-trackers.md, section 3); the other two merge in the checkout.
 */
export const LANDINGS = ["merge", "fast-forward", "pull-request"] as const;
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
 * An exit a task's run named: the block that named it, the exit's id, its
 * name as the drawing stands now (absent when the drawing no longer has it),
 * and the commit it was named on.
 */
export interface NamedExit {
  readonly node: string;
  readonly id: string;
  readonly name: string | undefined;
  readonly commit: string | undefined;
}

/**
 * What placement and filters know about a task.
 *
 * Filters read these, never label strings or runs, so a change in how a fact
 * is recorded changes `factsOf` alone.
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
  /** Stopped attempts recorded against any rung. */
  readonly attempts: number;
  /** The task's tip: its branch tip, or the checkout's HEAD on a route with no branch. */
  readonly tip: string | undefined;
  /** The block of the task's open agent run, and whether its agent has named an exit. */
  readonly running: { readonly node: string; readonly named: boolean } | undefined;
  /** The exits the task named since it last left a source, oldest first. */
  readonly named: ReadonlyArray<NamedExit>;
  /** The name, as drawn now, of the last exit the task named, a return included. */
  readonly exit: string | undefined;
}

/** How far a task's run at the block it stands at has gone. */
export type RunState =
  /** Nothing runs yet. The gates on the way decide when it may start. */
  | "waiting"
  /** The block's run is under way. */
  | "running"
  /** The run's agent named its exit, and settle has not yet recorded it. */
  | "ended";

/** Where a task stands in a pipeline. */
export type Placement =
  /** No source takes the task, or its status puts it outside any flow. */
  | { readonly _tag: "Outside" }
  | { readonly _tag: "Parked"; readonly node: string }
  /**
   * The task's last exit is one the drawing no longer has, or was named at a
   * block it no longer has. Absence is an unknown, not evidence, so the task
   * waits for the operator rather than starting at its source again.
   */
  | {
      readonly _tag: "ExitGone";
      readonly node: string;
      readonly exit: string;
      readonly reason: string;
    }
  | {
      readonly _tag: "At";
      readonly node: WorkNode;
      readonly state: RunState;
      /** The gates between the last block it passed and this one. */
      readonly gates: ReadonlyArray<{ readonly id: string; readonly step: Step }>;
      /** Work blocks after this one, on the route its facts take now. */
      readonly ahead: number;
      /**
       * The block a board draws the task on. A waiting task that has not
       * started (no exit placed it, no attempt, no failure) stands at the
       * source that took it; any other waiting task stands at the gate in
       * front of its block, else at the block. A running task stands at its
       * block.
       */
      readonly stands: string;
    };

/**
 * Where a task with these facts stands in `pipeline`.
 *
 * A task with an open agent run is at that run's block. Otherwise it is where
 * its last exit leads: the walk takes that exit's wire on the block as the
 * drawing stands now, and goes on through routers, gates and workspace blocks
 * to the next work block. A task with no exit, or an open one (back in the
 * queue), walks from the first source whose filter matches. A task whose last
 * exit names a block or an exit no longer drawn is `ExitGone`.
 *
 * An exit holds for the commit it was named on. A check passes one commit, and
 * a land or a done takes the commit the exit before it was named on, so an
 * exit at a check, or one whose walk reaches a land or a done, is void once
 * the tip has moved: the task is placed by the exit before it, which stands
 * it at the block that named the void one.
 *
 * A task with no run and no named exit (work launched by hand) is placed at
 * an author as running while `in_progress`. Its step otherwise comes from its
 * named exits, and an author reached that way is waiting.
 */
export const place = (pipeline: Pipeline, facts: Facts): Placement => {
  if (facts.status !== "open" && facts.status !== "in_progress") {
    return { _tag: "Outside" };
  }
  const nodes = indexOf(pipeline);
  const source = sourceOf(pipeline, facts);
  if (source === undefined) return { _tag: "Outside" };
  const bound = pipeline.nodes.length;

  const named = facts.status === "open" ? [] : facts.named;
  let reached = walk(nodes, source.next, facts, bound);
  // A named exit that still wires places the task. One wired to the queue
  // leaves the walk at the source; one the drawing lost places it nowhere.
  let viaExit = false;
  let gone: NamedExit | undefined;
  for (let last = named.length - 1; last >= 0; last--) {
    const exit = named[last]!;
    const wire = wireOf(nodes, exit);
    if (wire._tag === "Gone") {
      gone = exit;
      break;
    }
    if (wire._tag === "Queue") break;
    const target = walk(nodes, wire.exit.to, facts, bound);
    // A land or a done takes the commit the exit was named on, so an exit
    // that names none, or names one the tip has moved past, binds nothing.
    const moved = exit.commit === undefined || exit.commit !== facts.tip;
    const binds =
      nodes.get(exit.node)?.kind === "check" ||
      target.node?.kind === "land" ||
      target.node?.kind === "done";
    if (moved && binds) continue;
    reached = target;
    viaExit = true;
    break;
  }

  const open = facts.status === "open" ? undefined : facts.running;
  const runningAt = open === undefined ? undefined : nodes.get(open.node);
  if (open !== undefined && runningAt?.kind === "agent") {
    return {
      _tag: "At",
      node: runningAt,
      // A named exit is the evidence the agent handed off; settle closes the
      // run once the pane is idle, and the next tick places where the exit leads.
      state: open.named ? "ended" : "running",
      gates: reached.node?.id === runningAt.id ? reached.gates : [],
      ahead: aheadOf(nodes, runningAt, facts, bound),
      stands: runningAt.id,
    };
  }
  if (gone !== undefined) {
    return {
      _tag: "ExitGone",
      node: gone.node,
      exit: gone.id,
      reason: nodes.has(gone.node)
        ? `${gone.node} no longer has the exit ${gone.id} the task's run named there`
        : `the pipeline no longer has the block ${gone.node}, where the task's run named ${gone.id}`,
    };
  }
  const { node, gates } = reached;
  if (node === undefined) return { _tag: "Outside" };
  if (node.kind === "park") return { _tag: "Parked", node: node.id };
  const state = stateByStatus(node, facts, viaExit);
  return {
    _tag: "At",
    node,
    state,
    gates,
    ahead: aheadOf(nodes, node, facts, bound),
    stands:
      state !== "waiting"
        ? node.id
        : !viaExit && facts.attempts === 0 && facts.failedBy.size === 0
          ? source.id
          : (gates.at(-1)?.id ?? node.id),
  };
};

/**
 * Where the task's route puts its agents, or nothing when no source takes it.
 *
 * Validation keeps every workspace block before the route's first agent, so
 * the answer holds for the whole route. The walk reads routers by the facts
 * and ignores the task's exits, so it needs no tip: the tip is read from the
 * workspace this answers.
 */
export const routeWorkspace = (pipeline: Pipeline, facts: Facts): Workspace | undefined => {
  const nodes = indexOf(pipeline);
  let node: PipelineNode | undefined = sourceOf(pipeline, facts);
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
 * The first agent block of `role` on the task's route from where it stands,
 * or nothing when its route has none.
 *
 * This is where an agent the operator starts by hand runs. The operator can
 * start it before the task reaches that block, so each work block before it
 * on the route counts as passed by its advance: its first exit that does not
 * return the task to the queue.
 */
export const nextAgent = (
  pipeline: Pipeline,
  facts: Facts,
  role: AgentNode["role"],
): AgentNode | undefined => {
  const placement = place(pipeline, { ...facts, running: undefined });
  if (placement._tag !== "At") return undefined;
  const nodes = indexOf(pipeline);
  let node: PipelineNode | undefined = placement.node;
  for (let steps = 0; steps <= pipeline.nodes.length; steps++) {
    if (node?.kind === "agent" && node.role === role) return node;
    const advance: Exit | undefined =
      node?.kind === "agent" || node?.kind === "check" ? advanceOf(node) : undefined;
    if (advance === undefined) return undefined;
    node = walk(nodes, advance.to, facts, pipeline.nodes.length).node;
  }
  return undefined;
};

/**
 * What an agent block may name: the rungs, each with whether it may author,
 * and the reviewers.
 */
export interface SeatOffers {
  readonly rungs: ReadonlyArray<{ readonly name: string; readonly author: boolean }>;
  readonly reviewers: ReadonlyArray<string>;
}

/** What the ladder and the reviewers offer an agent block to name. */
export const offersOf = (seats: Seats): SeatOffers => ({
  rungs: seats.ladder.map((rung) => ({ name: rung.name, author: mayAuthor(rung) })),
  reviewers: seats.reviewers.map((reviewer) => reviewer.name),
});

/**
 * Why a pipeline cannot run, or nothing when it can.
 *
 * A pipeline that fails is not run at all: its project takes no step. It never
 * falls back to the standard pipeline, because running a flow the operator did
 * not draw is worse than stopping.
 */
export const problemsOf = (pipeline: Pipeline, offers: SeatOffers): ReadonlyArray<string> => {
  const shape = shapeProblems(pipeline, offers);
  if (shape.length > 0) return shape;

  const wired = graphOf(pipeline);
  const sources = pipeline.nodes.filter((node) => node.kind === "source");
  const work = pipeline.nodes.filter(isWork);
  const problems: Array<string> = [...cycleProblems(pipeline)];

  const ends = pipeline.nodes.filter(
    (node) => node.kind === "land" || node.kind === "done" || node.kind === "park",
  );
  for (const node of pipeline.nodes) {
    if (!sources.some((source) => wired.reaches(source.id, node.id))) {
      problems.push(`no source reaches ${node.id}`);
    }
    if (!ends.some((end) => end.id === node.id || wired.reaches(node.id, end.id))) {
      problems.push(`no route from ${node.id} reaches a land, a done or a park`);
    }
  }

  const authors = work.filter(isRole("author"));
  const nodes = indexOf(pipeline);
  // A reviewer checks a claim against trunk. A new author run starts a new
  // lap, which leaves the claim behind, so no author may run between the
  // claim and its review. A land or a done before a review is the rule below.
  for (const author of authors) {
    const claim = author.kind === "agent" ? claimOf(author) : undefined;
    if (claim === undefined || claim.to === QUEUE) continue;
    for (const reached of authorsBeforeReview(nodes, claim.to)) {
      problems.push(`${author.id}: the claim ${claim.name} reaches ${reached.id} before a review`);
    }
  }
  const landings = work.filter((node) => node.kind === "land" || node.kind === "done");
  // Nothing skips review: no land or done after a source or an author but a reviewer.
  for (const [from, end] of skipping(
    pipeline,
    isRole("review"),
    [...sources, ...authors],
    landings,
  )) {
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
  // wrote it. A cycle therefore stays inside one workspace.
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
  // source or another work block must be out of reach. Exits are wires, so
  // this holds on every lap of a cycle too.
  const ungated = graphOf(
    pipeline,
    (node) => node.kind !== "gate",
    (node) => !isWork(node),
  );
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

  // A pull-request landing takes two steps the operator can stop: `publish`
  // pushes and opens the PR, `land` merges it. Each needs its own gate after
  // the last work block, because either step can be on while the other is not.
  // A publish gate before any other block would hold a step that never comes.
  const pullRequests = work.filter((node) => node.kind === "land" && node.how === "pull-request");
  const isGateFor = (step: Step) => (node: PipelineNode) =>
    node.kind === "gate" && node.step === step;
  for (const step of ["publish", "land"] as const) {
    for (const [from, target] of skipping(
      pipeline,
      isGateFor(step),
      [...sources, ...work.filter((node) => node.kind === "agent" || node.kind === "check")],
      pullRequests,
    )) {
      problems.push(`a route from ${from.id} reaches ${target.id} with no ${step} gate after it`);
    }
  }
  for (const gate of pipeline.nodes.filter(isGateFor("publish"))) {
    if (!pullRequests.some((target) => wired.reaches(gate.id, target.id))) {
      problems.push(`${gate.id} gates publish, but no route from it reaches a pull-request land`);
    }
  }

  return [...new Set(problems)];
};

/**
 * The cycles that can loop forever. A lap of a cycle ends in time when it
 * passes an exit that charges a rung (`fails`), since a task that every rung
 * has failed parks, or a router with a route out of the cycle whose filter is a
 * count that grows on each lap. So with those exits and routers taken out, any
 * cycle left with a work block on it can loop forever, and one with none would
 * spin without a run.
 */
const cycleProblems = (pipeline: Pipeline): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const pathOf = (blocks: ReadonlyArray<PipelineNode>) => blocks.map((node) => node.id).join(", ");
  for (const blocks of loopsOf(graphOf(pipeline).graph)) {
    if (!blocks.some(isWork)) {
      problems.push(`the wires loop through ${pathOf(blocks)} with no work block on the loop`);
      continue;
    }
    const ids = new Set(blocks.map((node) => node.id));
    const named = new Set(
      blocks.flatMap((node) =>
        node.kind === "agent" || node.kind === "check" ? node.exits.map((exit) => exit.name) : [],
      ),
    );
    const counts = (node: PipelineNode) =>
      node.kind === "router" &&
      node.routes.some((route) => !ids.has(route.to) && growsEachLap(route.when, named));
    const unbounded = graphOf(
      { nodes: blocks },
      (node) => !counts(node),
      () => true,
      (wire) => !wire.fails,
    );
    for (const loop of loopsOf(unbounded.graph)) {
      problems.push(
        loop.some(isWork)
          ? `the wires loop through ${pathOf(loop)}, and nothing ends the loop: no exit on it fails a rung, and no router leaves it on a count that grows`
          : `the wires loop through ${pathOf(loop)} with no work block on the loop`,
      );
    }
  }
  return problems;
};

/** The strongly connected components of a graph that hold a cycle, as their blocks. */
const loopsOf = (
  graph: Graph.DirectedGraph<PipelineNode, string>,
): ReadonlyArray<ReadonlyArray<PipelineNode>> =>
  Graph.stronglyConnectedComponents(graph).flatMap((component) => {
    const blocks = component.flatMap((at) => Option.toArray(Graph.getNode(graph, at)));
    const looped =
      blocks.length > 1 || blocks.some((node) => wiresOf(node).some((wire) => wire.to === node.id));
    return looped ? [blocks] : [];
  });

/**
 * Whether a filter holds a count that grows on each lap of a cycle, such as
 * `exits:returned>=3`. An `exits:` count grows only when a block on the cycle,
 * one of `named`, declares that exit.
 */
const growsEachLap = (filter: string, named: ReadonlySet<string>): boolean =>
  filter
    .trim()
    .split(/\s+/)
    .some((term) => {
      const count = /^(?:exits:([a-z-]+)|attempts)>=\d+$/.exec(term);
      return count !== null && (count[1] === undefined || named.has(count[1]));
    });

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

/**
 * The names an agent block's instructions may use as `{{ name }}`. Foreman
 * writes everything else an agent needs into the sections it generates, so
 * the operator's text stays the same whatever the drawing or the workspace.
 */
export const PLACEHOLDERS = ["task", "branch", "base", "worktree"] as const;

/** The instructions file an agent block reads: its own, or its role's. */
export const instructionsOf = (node: AgentNode): string => node.instructions ?? node.role;

/** Whether `name` can name an instructions file `<name>.md`: a-z, 0-9 and -, so it stays in its directory. */
export const isInstructionsName = (name: string): boolean => /^[a-z0-9-]+$/.test(name);

/** Every `{{ name }}` in a text, in order. */
export const placeholdersIn = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/\{\{\s*(.*?)\s*\}\}/g)].map((match) => match[1] ?? "");

/** The instructions names a pipeline's agent blocks read. */
export const instructionNames = (pipeline: Pipeline): ReadonlyArray<string> =>
  pipeline.nodes.flatMap((node) => (node.kind === "agent" ? [instructionsOf(node)] : []));

/**
 * The problems in a pipeline's instructions, given the text each name reads
 * (absent when no file has that name). A missing file or a placeholder
 * outside `PLACEHOLDERS` would fail every dispatch of the block, so the
 * pipeline does not run.
 */
export const instructionProblems = (
  pipeline: Pipeline,
  texts: ReadonlyMap<string, string>,
): ReadonlyArray<string> =>
  pipeline.nodes.flatMap((node) => {
    if (node.kind !== "agent") return [];
    const name = instructionsOf(node);
    if (!isInstructionsName(name)) {
      return [`${node.id}: instructions ${name} is no file name: use a-z, 0-9 and -`];
    }
    const text = texts.get(name);
    if (text === undefined)
      return [`${node.id}: no readable instructions file is named ${name}.md`];
    const allowed: ReadonlyArray<string> = PLACEHOLDERS;
    return placeholdersIn(text)
      .filter((placeholder) => !allowed.includes(placeholder))
      .map(
        (placeholder) =>
          `${node.id}: ${name}.md uses {{ ${placeholder} }}, which is no placeholder: use ${PLACEHOLDERS.join(", ")}`,
      );
  });

const isRole =
  (role: AgentNode["role"]) =>
  (node: PipelineNode): boolean =>
    node.kind === "agent" && node.role === role;

/**
 * The exits each kind of block has when the drawing names none, each with its
 * name as its id: an author's `done` and `already-done` advance, and
 * `already-done` is the claim; a reviewer's `approved` advances and `returned`
 * sends the task back to the queue charged to its author; a check's `passed`
 * and `failed` do the same.
 */
export const standardExits = (
  node: { readonly kind: "agent"; readonly role: AgentNode["role"] } | { readonly kind: "check" },
  next: string,
): ReadonlyArray<Exit> =>
  node.kind === "check"
    ? [
        { id: "passed", name: "passed", to: next },
        { id: "failed", name: "failed", to: QUEUE, fails: "author" },
      ]
    : node.role === "author"
      ? [
          { id: "done", name: "done", to: next },
          { id: "already-done", name: "already-done", to: next, empty: "claim" },
        ]
      : [
          { id: "approved", name: "approved", to: next },
          { id: "returned", name: "returned", to: QUEUE, fails: "author" },
        ];

/**
 * Where a standard pipeline puts its agents (docs/workspace-blocks.md):
 *
 * - `checkout`: the operator's checkout, on the task's branch.
 * - `worktree`: a separate worktree, on the task's branch.
 * - `direct`: the operator's checkout, on the operator's branch. It has no
 *   branch to land, so it ends at `done`.
 */
export const WORKSPACE_CHOICES = ["checkout", "worktree", "direct"] as const;
export type WorkspaceChoice = (typeof WORKSPACE_CHOICES)[number];

/**
 * The standard pipeline for each workspace: author, review, then land (or
 * done for direct).
 *
 * A returned review goes straight to `climb`, keeping the claim and workspace.
 * The router sends queued retries there too, so the `climb` step governs
 * retries apart from a first try.
 */
export const STANDARD_PIPELINES: Record<WorkspaceChoice, Pipeline> = {
  checkout: standardPipeline([{ kind: "branch", id: "branch", next: "retry" }], {
    kind: "land",
    id: "land",
    how: "merge",
  }),
  worktree: standardPipeline(
    [
      { kind: "branch", id: "branch", next: "worktree" },
      { kind: "worktree", id: "worktree", next: "retry" },
    ],
    { kind: "land", id: "land", how: "merge" },
  ),
  direct: standardPipeline([], { kind: "done", id: "done" }),
};

/** The pipeline of a project that has drawn none: its agents work in the operator's checkout. */
export const DEFAULT_PIPELINE = STANDARD_PIPELINES.checkout;

/** The standard workspace `pipeline` is exactly, if any. */
export const choiceOf = (pipeline: Pipeline): WorkspaceChoice | undefined => {
  const encoded = JSON.stringify(S.encodeSync(Pipeline)(pipeline));
  return WORKSPACE_CHOICES.find(
    (workspace) =>
      JSON.stringify(S.encodeSync(Pipeline)(STANDARD_PIPELINES[workspace])) === encoded,
  );
};

/**
 * The standard blocks after `workspace`, which leads from the source into the
 * router `retry`, ending at `end`. A function declaration, so the constant
 * above can call it while the module loads.
 */
function standardPipeline(
  workspace: ReadonlyArray<PipelineNode>,
  end: PipelineNode & { readonly id: string },
): Pipeline {
  return {
    nodes: [
      { kind: "source", id: "queue", filter: "", next: workspace[0]?.id ?? "retry" },
      ...workspace,
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
      {
        kind: "agent",
        id: "author",
        role: "author",
        model: "ladder",
        exits: standardExits({ kind: "agent", role: "author" }, "review-gate"),
      },
      { kind: "gate", id: "review-gate", step: "review", next: "review" },
      {
        kind: "agent",
        id: "review",
        role: "review",
        model: "reviewers",
        exits: [
          { id: "approved", name: "approved", to: "land-gate" },
          { id: "returned", name: "returned", to: "climb", fails: "author" },
        ],
      },
      { kind: "gate", id: "land-gate", step: "land", next: end.id },
      end,
    ],
  };
}

/** The pipeline as a Mermaid flowchart, one arrow per wire. A return to the queue draws none. */
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
 * `failed:<rung>`, `exit:<name>` (the task's last exit), and `size`,
 * `priority`, `attempts` or `exits:<name>` (the times the task named that exit
 * since it last left a source) compared with `<=`, `>=` or `=` to a whole
 * number. A leading `-` negates a term. A filter that does not parse matches
 * nothing; validation is where it is reported.
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
  const compared = /^(size|priority|attempts|exits:[a-z-]+)(<=|>=|=)(\d+)$/.exec(term);
  if (compared !== null) {
    const [, field, op, raw] = compared;
    const bound = Number(raw);
    const read = (facts: Facts): number =>
      field === "size"
        ? facts.size
        : field === "priority"
          ? facts.priority
          : field === "attempts"
            ? facts.attempts
            : facts.named.filter((exit) => `exits:${exit.name}` === field).length;
    return (facts) => {
      const n = read(facts);
      return op === "<=" ? n <= bound : op === ">=" ? n >= bound : n === bound;
    };
  }
  const [kind, ...rest] = term.split(":");
  const value = rest.join(":");
  if (value === "") return undefined;
  switch (kind) {
    case "label":
      return (facts) => facts.labels.has(value);
    case "epic":
      return (facts) => facts.epic === value;
    case "failed":
      return (facts) => facts.failedBy.has(value);
    case "exit":
      return (facts) => facts.exit === value;
  }
  return undefined;
};

/** The checks that need no walk: names, wires, exits, filters and models. */
const shapeProblems = (pipeline: Pipeline, offers: SeatOffers): Array<string> => {
  const problems: Array<string> = [];
  const ids = new Set<string>();
  for (const node of pipeline.nodes) {
    if (ids.has(node.id)) problems.push(`two blocks are named ${node.id}`);
    ids.add(node.id);
  }
  if (!pipeline.nodes.some((node) => node.kind === "source")) {
    problems.push("no source supplied");
  }
  const declared = new Set(
    pipeline.nodes.flatMap((node) =>
      node.kind === "agent" || node.kind === "check" ? node.exits.map((exit) => exit.name) : [],
    ),
  );
  for (const node of pipeline.nodes) {
    for (const { to } of wiresOf(node)) {
      if (!ids.has(to)) problems.push(`${node.id} is wired to ${to}, which is no block`);
    }
    for (const filter of filtersOf(node)) {
      const parsed = parseFilter(filter);
      if (parsed._tag === "Invalid") problems.push(`${node.id}: ${parsed.reason}`);
      for (const name of exitsNamedBy(filter)) {
        if (!declared.has(name)) {
          problems.push(`${node.id}: the filter counts the exit ${name}, and no block declares it`);
        }
      }
    }
    if (node.kind === "agent" || node.kind === "check") problems.push(...exitProblems(node));
    if (node.kind === "agent") problems.push(...modelProblems(node, offers));
    if (node.kind === "check" && node.command.trim() === "") {
      problems.push(`${node.id}: a check runs a command, and it names none`);
    }
  }
  return problems;
};

const exitProblems = (node: AgentNode | CheckNode): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const names = node.exits.map((exit) => exit.name);
  const ids = node.exits.map((exit) => exit.id);
  const unseated = unseatedBy(node);
  const endings: ReadonlyArray<string> = PROCESS_ENDINGS;
  if (node.kind === "agent" && names.length === 0) {
    problems.push(`${node.id}: an agent names an exit to end its run, and it declares none`);
  }
  if (
    node.kind === "check" &&
    ([...ids].sort().join(" ") !== "failed passed" ||
      node.exits.some((exit) => exit.id !== exit.name))
  ) {
    problems.push(`${node.id}: a check's exits are passed and failed`);
  }
  for (const [at, exit] of node.exits.entries()) {
    if (names.indexOf(exit.name) !== at) {
      problems.push(`${node.id}: two exits are named ${exit.name}`);
    }
    if (ids.indexOf(exit.id) !== at) {
      problems.push(`${node.id}: two exits have the id ${exit.id}`);
    }
    if (exit.id === "") problems.push(`${node.id}: the exit ${exit.name} has no id`);
    if (!/^[a-z-]+$/.test(exit.name)) {
      problems.push(`${node.id}: the exit ${exit.name} is not lower-case words and hyphens`);
    }
    // A run stores the exit's id where it would store how it stopped, so an
    // id that reads as a stop would be read as one.
    for (const word of new Set([exit.name, exit.id])) {
      if (endings.includes(word)) {
        problems.push(`${node.id}: ${word} is how a run stops with no exit, not an exit`);
      }
    }
    if (unseated !== undefined && exit.fails === "self") {
      problems.push(`${node.id}: ${unseated}, so ${exit.name} has none to fail`);
    }
    if (exit.empty === "claim" && (node.kind !== "agent" || node.role !== "author")) {
      problems.push(`${node.id}: only an author claims trunk already does the task`);
    }
    if (exit.empty === "claim" && exit.to === QUEUE) {
      problems.push(
        `${node.id}: the claim ${exit.name} returns the task to the queue, and a claim leads to a review`,
      );
    }
  }
  const claims = node.exits.filter((exit) => exit.empty === "claim");
  if (claims.length > 1) {
    problems.push(
      `${node.id}: an author has at most one claim, and ${claims.map((exit) => exit.name).join(", ")} are claims`,
    );
  }
  return problems;
};

/**
 * The author blocks a task reaches from block `from` before any review, on
 * every route the routers can take while nothing fails: through a check by its
 * `passed` exit, since a failed check sends the claim where the drawing says.
 * A route ends at a review, at a land, a done or a park, and at the first
 * author it meets.
 */
const authorsBeforeReview = (
  nodes: ReadonlyMap<string, PipelineNode>,
  from: string,
): ReadonlyArray<PipelineNode> => {
  const seen = new Set<string>();
  const found: Array<PipelineNode> = [];
  const visit = (id: string) => {
    const node = nodes.get(id);
    if (node === undefined || seen.has(id) || isRole("review")(node)) return;
    seen.add(id);
    if (isRole("author")(node)) {
      found.push(node);
      return;
    }
    if (node.kind === "check") {
      const passed = node.exits.find((exit) => exit.id === "passed");
      if (passed !== undefined) visit(passed.to);
      return;
    }
    for (const wire of wiresOf(node)) visit(wire.to);
  };
  visit(from);
  return found;
};

/** Why a block has no rung for `fails: self` to charge; nothing for an author block. */
const unseatedBy = (node: AgentNode | CheckNode): string | undefined =>
  node.kind === "check"
    ? "a check runs on no rung"
    : node.role === "review"
      ? "a reviewer is no rung"
      : undefined;

const modelProblems = (node: AgentNode, offers: SeatOffers): ReadonlyArray<string> => {
  if (node.role === "review") {
    if (node.model === "ladder") {
      return [`${node.id}: a reviewer reads from the reviewers, not from the ladder`];
    }
    return node.model === "reviewers" || offers.reviewers.includes(node.model)
      ? []
      : [`${node.id}: ${node.model} is no reviewer`];
  }
  if (node.model === "ladder") return [];
  if (node.model === "reviewers") {
    return [`${node.id}: an author writes from the ladder, not from the reviewers`];
  }
  const offer = offers.rungs.find((rung) => rung.name === node.model);
  if (offer === undefined) return [`${node.id}: ${node.model} is no rung on the ladder`];
  return offer.author ? [] : [`${node.id}: ${node.model} may not author`];
};

/**
 * The pipeline as a directed graph of the blocks `keep` accepts, with the
 * wires out of each block `follow` accepts that `take` accepts. A return to the
 * queue is no wire.
 */
const graphOf = (
  pipeline: Pipeline,
  keep: (node: PipelineNode) => boolean = () => true,
  follow: (node: PipelineNode) => boolean = () => true,
  take: (wire: { readonly fails?: boolean }) => boolean = () => true,
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
        if (to !== undefined && take(wire)) Graph.addEdge(mutable, from, to, wire.label);
      }
    }
  });
  return {
    graph,
    reaches: (from: string, to: string): boolean => {
      const a = index.get(from);
      const b = index.get(to);
      return a !== undefined && b !== undefined && Graph.hasPath(graph, a, b);
    },
  };
};

/** The wires out of a block, returns to the queue left out. */
const wiresOf = (
  node: PipelineNode,
): ReadonlyArray<{ readonly to: string; readonly label: string; readonly fails?: boolean }> => {
  switch (node.kind) {
    case "source":
    case "gate":
    case "branch":
    case "worktree":
      return [{ to: node.next, label: "" }];
    case "agent":
    case "check":
      return node.exits.flatMap((exit) =>
        exit.to === QUEUE
          ? []
          : [{ to: exit.to, label: exit.name, fails: exit.fails !== undefined }],
      );
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

/**
 * The exits a filter's `exit:` and `exits:` terms name, but for the endings of a
 * run that named none. A renamed or removed exit leaves such a term matching
 * nothing.
 */
const exitsNamedBy = (filter: string): ReadonlyArray<string> =>
  filter
    .trim()
    .split(/\s+/)
    .flatMap((word) => {
      const name = /^-?exits?:([a-z-]+)/.exec(word)?.[1];
      return name === undefined || (PROCESS_ENDINGS as ReadonlyArray<string>).includes(name)
        ? []
        : [name];
    });

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

const sourceOf = (pipeline: Pipeline, facts: Facts) =>
  pipeline.nodes.find(
    (node): node is typeof SourceNode.Type => node.kind === "source" && matches(facts, node.filter),
  );

const routeOf = (router: typeof RouterNode.Type, facts: Facts): string =>
  router.routes.find((route) => matches(facts, route.when))?.to ?? router.else;

/**
 * The exit with id `exit` at block `node`, as the drawing stands now: nothing
 * when the block or the exit is gone.
 */
export const exitAt = (
  pipeline: Pipeline,
  node: string | undefined,
  exit: string | undefined,
): Exit | undefined => {
  const block = pipeline.nodes.find((candidate) => candidate.id === node);
  return block?.kind === "agent" || block?.kind === "check"
    ? block.exits.find((candidate) => candidate.id === exit)
    : undefined;
};

/** An author block's claim exit (`empty: claim`), if it declares one. */
export const claimOf = (node: AgentNode): Exit | undefined =>
  node.role === "author" ? node.exits.find((exit) => exit.empty === "claim") : undefined;

/**
 * What a named exit leads to as the drawing stands now: its wire, a return to
 * the queue, or nothing at all, when its block or the exit itself is gone.
 */
const wireOf = (
  nodes: ReadonlyMap<string, PipelineNode>,
  named: NamedExit,
):
  | { readonly _tag: "Wire"; readonly exit: Exit }
  | { readonly _tag: "Queue" }
  | { readonly _tag: "Gone" } => {
  const node = nodes.get(named.node);
  const exit =
    node?.kind === "agent" || node?.kind === "check"
      ? node.exits.find((candidate) => candidate.id === named.id)
      : undefined;
  if (exit === undefined) return { _tag: "Gone" };
  return exit.to === QUEUE ? { _tag: "Queue" } : { _tag: "Wire", exit };
};

/** The exit that moves a task on from a work block: its first that does not return it. */
const advanceOf = (node: WorkNode): Exit | undefined =>
  node.kind === "agent" || node.kind === "check"
    ? node.exits.find((exit) => exit.to !== QUEUE)
    : undefined;

/**
 * From block `from`, through routers, gates and workspace blocks, to the next
 * work block or park, with the gates on the way. The walk is bounded by the
 * graph's size, because placement may be asked about a pipeline that was
 * never validated.
 */
const walk = (
  nodes: ReadonlyMap<string, PipelineNode>,
  from: string,
  facts: Facts,
  bound: number,
): {
  readonly node: WorkNode | typeof ParkNode.Type | undefined;
  readonly gates: ReadonlyArray<{ readonly id: string; readonly step: Step }>;
} => {
  const gates: Array<{ id: string; step: Step }> = [];
  let node = nodes.get(from);
  for (let steps = 0; node !== undefined && steps <= bound; steps++) {
    switch (node.kind) {
      case "gate":
        gates.push({ id: node.id, step: node.step });
        node = nodes.get(node.next);
        continue;
      case "router":
        node = nodes.get(routeOf(node, facts));
        continue;
      case "source":
      case "branch":
      case "worktree":
        node = nodes.get(node.next);
        continue;
      default:
        return { node, gates };
    }
  }
  return { node: undefined, gates };
};

/**
 * The state at a block the walk reached, with no open agent run there. A
 * check, a land and a done run inside one tick and leave no open run, so a
 * task at one is always waiting there. An author with no run is work launched
 * by hand when no exit placed it (`in_progress` means running); an author a
 * named exit walked to (a returned review through climb) is waiting for its
 * next dispatch, still `in_progress`.
 */
const stateByStatus = (node: WorkNode, facts: Facts, viaExit: boolean): RunState =>
  node.kind === "agent" && node.role === "author" && facts.running === undefined
    ? facts.status === "in_progress" && !viaExit
      ? "running"
      : "waiting"
    : "waiting";

/**
 * Whether placement puts the task past the author's running turn: an author
 * that named its exit, or any later block (review, check, land, done). The
 * dispatcher splits `in_progress` work into working vs review by this — the
 * review column and fill's check/land candidates both read that half. A
 * returned author waiting at climb stays claimed; fill picks it up from the
 * claimed waiting set, not from this half.
 */
export const isUnderReview = (placement: Placement): boolean => {
  if (placement._tag !== "At") return false;
  const { node, state } = placement;
  if (node.kind === "agent" && node.role === "author") return state === "ended";
  return true;
};

/** Work blocks after `from` on the route the facts take now, each passed by its advance. */
const aheadOf = (
  nodes: ReadonlyMap<string, PipelineNode>,
  from: WorkNode,
  facts: Facts,
  bound: number,
): number => {
  let count = 0;
  let at: WorkNode = from;
  for (let steps = 0; steps <= bound; steps++) {
    const advance = advanceOf(at);
    if (advance === undefined) return count;
    const { node } = walk(nodes, advance.to, facts, bound);
    if (node === undefined || node.kind === "park") return count;
    count++;
    if (node.kind === "land" || node.kind === "done") return count;
    at = node;
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
