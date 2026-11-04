// A project's tasks played through a pipeline on a clock, decided by the
// rules the dispatcher runs. After each event the tasks are placed with
// `place`, `candidatesFrom` and `planFrom` plan the dispatches, landings and
// checks with the dispatcher's own reading, and each step is folded with the
// trace's events (`pipeline-trace.ts`) over the tasks held in memory. Only
// each run's outcome and minutes, and each check's result, are drawn, from
// the measured rates (`run-rates.ts`). Nothing is read from or written to the
// store.
import { drawSeat, type PerRole } from "./agent-rung.ts";
import {
  candidatesFrom,
  type Held,
  occupancyOf,
  placementIn,
  type Plan,
  planFrom,
  workspaceOf,
} from "./dispatcher.ts";
import { labelFor, type Worker } from "./fleet.ts";
import { isEnabled, mayAuthor } from "./ladder.ts";
import { isUnderReview, type Pipeline, type Placement, type RunState } from "./pipeline.ts";
import type { ProjectPipeline } from "./pipeline-file.ts";
import {
  afterEvent,
  handedOff,
  offersAt,
  openRung,
  started,
  tipOf,
  TRACE_ASSUMES,
  type TraceEvent,
  type TraceRules,
} from "./pipeline-trace.ts";
import { DEFAULT_POLICY, type Policy } from "./policy.ts";
import { queueFrom } from "./queue.ts";
import type { EpicProgress, Item } from "./records.ts";
import { type AgentRate, drawMinutes, medianOf, type Rates } from "./run-rates.ts";
import { openAgentOf, type StepRules } from "./run-step.ts";

/** What a simulation assumes, which the dispatcher reads from the world instead. */
export const SIMULATE_ASSUMES = {
  accounts: TRACE_ASSUMES.accounts,
  gates:
    "Every step is on and every gate is granted, whatever the policy says. Only the policy's slots are read.",
  landings:
    "Every landing merges and verifies. Landings and checks happen on the dispatcher's ticks, one poll interval apart, and take no time of their own.",
  checks:
    "A check passes at its block's measured rate. A check block with no run passes every time (Assumed).",
  outcomes:
    "An agent's run names an exit its block declares that some run in its role named, stops, or meets a usage wall where one shows, at the blended rates, scaled to sum to one. A block none of whose exits any run named shares the blended exit rate evenly among its exits. A stop is settled as an agent idle past the grace. A run never vanishes.",
  durations:
    "A run's minutes are drawn from its rung's own runs, else from its role's. An agent running at the start takes a fresh draw. A run takes at least one minute.",
  tasks:
    "The tasks are the project's ready and claimed tasks at the start, in the queue's order. A blocked task stays out, even once its blocker lands. A parked task, and one that every rung has failed, is parked from the start. A claimed task with no open run (work started by hand) stays where it stands. Every author commits something, so a reviewer always has work to read.",
  holds:
    "No checkout is dirty and no project is paused. A claimed task on a branch in the checkout, once an author has run, has its branch out there, which holds the checkout. A direct task holds it from its first author run until it leaves the pipeline, as in the dispatcher.",
} as const;

/** The most frames a run writes: events closer than `hours / MAX_FRAMES`, or 0.05 h, share one. */
export const MAX_FRAMES = 1000;

/** What a simulation starts from: the project's tasks as the store holds them now. */
export interface SimulateWorld {
  readonly project: string;
  /** Unblocked, unclaimed tasks. */
  readonly ready: ReadonlyArray<Item>;
  /** Claimed tasks, under review or not. */
  readonly claimed: ReadonlyArray<Item>;
  readonly epics: ReadonlyArray<EpicProgress>;
  /** When the store was read: the queue ranks by it. */
  readonly now: Date;
  /** How many agents may work at once, from the policy. */
  readonly slots: number;
  /** Seconds between the dispatcher's ticks, from the config. */
  readonly pollSeconds: number;
}

/** Where a task stands in a frame: a block's run state, or out of the pipeline for good or for now. */
export type FrameState = RunState | "landed" | "parked" | "outside";

export interface Standing {
  readonly task: string;
  /** The block a board draws the task on (a placement's `stands`), or null outside the pipeline. */
  readonly node: string | null;
  readonly state: FrameState;
}

/**
 * The tasks that moved at one time. The first frame holds every task; each
 * later one holds only the tasks whose block or state changed since the frame
 * before it, and a time when none moved has no frame, so the board at a frame
 * is the fold of the frames up to it.
 */
export interface Frame {
  /** Hours since the start. */
  readonly at: number;
  readonly moves: ReadonlyArray<Standing>;
}

/** Where every task stands at a time: a frame before the moves are taken out. */
interface Board {
  readonly at: number;
  readonly standings: ReadonlyArray<Standing>;
}

export interface SimulatedTask {
  readonly id: string;
  readonly title: string;
  readonly landedAt: number | null;
  readonly parkedAt: number | null;
  /** The block a task still in flight stands at when the run ends. */
  readonly at: string | null;
}

/** One pipeline's run: where each task stood over time, and how each ended. */
export interface SimulatedRun {
  readonly frames: ReadonlyArray<Frame>;
  readonly tasks: ReadonlyArray<SimulatedTask>;
  /** The agent runs each seat opened, per role: a reviewer may share a rung's name. */
  readonly runsBySeat: PerRole<Readonly<Record<string, number>>>;
  readonly landed: number;
  readonly parked: number;
  readonly inFlight: number;
  readonly outside: number;
}

/**
 * Plays `world`'s tasks through `pipeline` for `hours`, with outcomes drawn
 * from `rates` by a generator seeded with `seed`. The same input gives the
 * same run.
 *
 * The clock moves from one run's end to the next. At each, the run's drawn
 * outcome is folded, then the tasks are planned until no landing, check or
 * park is left, then the plan's dispatches open runs. The run ends when every
 * task has landed, parked or left the pipeline, when no run is open, or at
 * `hours`.
 */
export const simulate = (input: {
  readonly world: SimulateWorld;
  readonly pipeline: Pipeline;
  readonly drawn: boolean;
  readonly rates: Rates;
  readonly rules: Omit<StepRules, "pipeline">;
  readonly seed: number;
  readonly hours: number;
}): SimulatedRun => {
  const sim = startOf(input);
  settle(sim, 0);
  snapshot(sim, 0);
  for (;;) {
    const due = nextDue(sim);
    const at = Math.min(due?.end ?? Infinity, sim.tick ?? Infinity);
    if (at > input.hours) break;
    if (due !== undefined && due.end === at) {
      sim.pending.delete(due.id);
      step(sim, sim.tasks.get(due.id)!, due.event, at);
    }
    settle(sim, at);
    snapshot(sim, at);
    if (live(sim).every((task) => placementOf(sim, task)._tag === "Outside")) break;
  }
  return resultOf(sim);
};

/** The pipelines a project's tasks are simulated through, with the problems that stop each. */
export interface SimulateSources {
  readonly draft:
    | { readonly pipeline: Pipeline; readonly problems: ReadonlyArray<string> }
    | undefined;
  readonly live: {
    readonly pipeline: Pipeline;
    readonly drawn: boolean;
    readonly problems: ReadonlyArray<string>;
  };
}

/**
 * What `foreman pipeline simulate --json` prints: the project's tasks played
 * through its draft and through the pipeline it runs, on the same seed, and
 * the rates both drew from. Without a draft, `draft` is `null`.
 */
export const simulateReport = (
  world: SimulateWorld,
  sources: SimulateSources,
  rates: Rates,
  rules: Omit<StepRules, "pipeline">,
  request: { readonly seed: number; readonly hours: number },
) => {
  const played = (pipeline: Pipeline, drawn: boolean) =>
    simulate({ world, pipeline, drawn, rates, rules, ...request });
  const { draft, live } = sources;
  const checks = [...(draft?.pipeline.nodes ?? []), ...live.pipeline.nodes].flatMap((node) =>
    node.kind === "check" ? [node.id] : [],
  );
  return {
    project: world.project,
    seed: request.seed,
    hours: request.hours,
    slots: world.slots,
    assumes: SIMULATE_ASSUMES,
    rates: [
      ...rules.ladder
        .filter((rung) => isEnabled(rung) && mayAuthor(rung))
        .map((rung) => rateJson(rates.agent(rung.name, "author"))),
      ...rules.reviewers.map((reviewer) => rateJson(rates.agent(reviewer.name, "review"))),
    ],
    checks: [...new Set(checks)].map((node) => rates.check(node)),
    draft:
      draft === undefined
        ? null
        : { source: "draft", problems: draft.problems, ...played(draft.pipeline, true) },
    saved: {
      source: live.drawn ? "saved" : "standard",
      problems: live.problems,
      ...played(live.pipeline, live.drawn),
    },
  };
};

export type SimulateReport = ReturnType<typeof simulateReport>;

/** One run in a line: how many tasks landed, parked and are still in flight, and the runs per seat. */
export const runSummary = (run: SimulateReport["saved"]): string => {
  const landings = run.tasks.flatMap((task) => (task.landedAt === null ? [] : [task.landedAt]));
  const median = medianOf(landings);
  const counted = (runs: Readonly<Record<string, number>>) =>
    Object.entries(runs)
      .map(([seat, count]) => `${seat} ${count}`)
      .join(", ");
  const rungs = counted(run.runsBySeat.author);
  const reviews = counted(run.runsBySeat.review);
  return [
    `${run.source}: ${run.landed} landed, ${run.parked} parked, ${run.inFlight} in flight, ${run.outside} outside`,
    median === undefined ? "" : `median ${Math.round(median * 10) / 10} h to land`,
    `runs: ${rungs || "none"}`,
    reviews === "" ? "" : `reviews: ${reviews}`,
    ...run.problems.map((problem) => `problem: ${problem}`),
  ]
    .filter((part) => part !== "")
    .join("  ");
};

/** A rate as JSON: each ending's blended share, and the median minutes it draws around. */
const rateJson = (rate: AgentRate) => ({
  rung: rate.rung ?? null,
  role: rate.role,
  n: rate.n,
  label: rate.label,
  endings: Object.fromEntries(
    [...rate.endings].map(([ending, share]) => [ending, Math.round(share * 1000) / 1000]),
  ),
  medianMinutes: roundedOrNull(medianOf(rate.own.length > 0 ? rate.own : rate.pool)),
});

/**
 * Draws the event a run ends with, out of what its block offers (`offersAt`):
 * an exit, `stop` or `wall`, weighted by the rung's blended rates and scaled
 * to sum to one. Exits no run in the role named are left out, unless none of
 * the block's was named: then the blended exit rate is shared evenly.
 */
const drawOutcome = (
  offers: ReadonlyArray<TraceEvent>,
  rate: AgentRate,
  random: () => number,
): TraceEvent => {
  const exits = offers.filter((offer) => offer.startsWith(EXIT));
  const named = exits.filter((offer) => rate.endings.has(offer.slice(EXIT.length)));
  const weighted: ReadonlyArray<readonly [TraceEvent, number]> = [
    ...(named.length > 0
      ? named.map((offer) => [offer, rate.endings.get(offer.slice(EXIT.length))!] as const)
      : exits.map((offer) => [offer, rate.success / exits.length] as const)),
    ...(offers.includes("stop") ? [["stop", rate.endings.get("stopped") ?? 0] as const] : []),
    ...(offers.includes("wall") ? [["wall", rate.endings.get("walled") ?? 0] as const] : []),
  ];
  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  let left = random() * total;
  for (const [event, weight] of weighted) {
    left -= weight;
    if (left < 0) return event;
  }
  return "stop";
};

const EXIT = "exit:";

/** A task held in memory, whose tip is made up (`tipOf`). */
type Simulated = Item & { readonly tip: string };

/** A simulation under way: its fixed inputs, and the tasks and runs as they stand. */
interface Sim {
  readonly world: SimulateWorld;
  readonly rules: TraceRules;
  readonly rates: Rates;
  readonly pipelines: ReadonlyMap<string, ProjectPipeline>;
  readonly policy: Policy;
  readonly random: () => number;
  /** Events closer than this, in hours, share a frame. */
  readonly window: number;
  /** The tasks' ids in the queue's order at the start, which every pass keeps. */
  readonly order: ReadonlyArray<string>;
  readonly tasks: Map<string, Simulated>;
  /** The run each working agent is on: when it ends, and how. */
  readonly pending: Map<string, { readonly end: number; readonly event: TraceEvent }>;
  /** The tasks that left for good: when, at which block, and how. */
  readonly ended: Map<
    string,
    { readonly at: number; readonly node: string | null; readonly how: "landed" | "parked" }
  >;
  readonly runsBySeat: PerRole<Map<string, number>>;
  readonly frames: Array<Board>;
  /** When the next tick settles again, after a tick that landed, checked or parked something. */
  tick: number | undefined;
}

/**
 * The simulation at hour 0. Every step is on, whatever the policy says. An
 * agent at work when the store was read takes a fresh draw from the start;
 * one that named an exit and is not yet settled hands off at once.
 */
const startOf = (input: Parameters<typeof simulate>[0]): Sim => {
  const { world } = input;
  const tasks = new Map<string, Simulated>(
    [...world.ready, ...world.claimed].map((task) => [task.id, { ...task, tip: tipOf(task.runs) }]),
  );
  const sim: Sim = {
    world,
    rules: { ...input.rules, pipeline: input.pipeline },
    rates: input.rates,
    pipelines: new Map([
      [world.project, { _tag: "Runs", pipeline: input.pipeline, drawn: input.drawn }],
    ]),
    policy: {
      ...DEFAULT_POLICY,
      slots: world.slots,
      default: { author: "on", climb: "on", review: "on", publish: "on", land: "on" },
    },
    random: mulberry32(input.seed),
    window: Math.max(0.05, input.hours / MAX_FRAMES),
    order: [...tasks.keys()],
    tasks,
    pending: new Map(),
    ended: new Map(),
    runsBySeat: { author: new Map(), review: new Map() },
    frames: [],
    tick: undefined,
  };
  for (const task of live(sim)) {
    const placement = placementOf(sim, task);
    const open = openAgentOf(sim.rules.pipeline, task);
    if (placement._tag !== "At" || open === undefined) continue;
    if (placement.state === "ended") {
      const exit = open.block.exits.find((candidate) => candidate.name === open.run.ending);
      tasks.set(task.id, handedOff(task, open.block, exit, sim.rules));
    } else if (placement.state === "running") {
      run(sim, task, sim.rates.agent(open.run.rung, open.block.role), 0);
    }
  }
  return sim;
};

/**
 * One tick of the dispatcher at `now`: the parks, landings and checks its plan
 * holds, then the dispatches of a plan read again after them, as a tick reads
 * the world again before it fills. A tick that took a step asks for the next
 * one a poll interval later, because what it moved may have a step of its own
 * (a check before a land); a check that fails back into itself then repeats
 * once a tick, as in the fleet.
 */
const settle = (sim: Sim, now: number) => {
  const first = planOf(sim);
  for (const task of first.parks) {
    sim.ended.set(task.id, { at: now, node: nodeOf(placementOf(sim, task)), how: "parked" });
  }
  for (const { task } of first.plan.lands) step(sim, sim.tasks.get(task.id)!, "landed", now);
  for (const { task, block } of first.plan.checks) {
    const passed = sim.random() < sim.rates.check(block.id).pass;
    step(sim, sim.tasks.get(task.id)!, passed ? "passed" : "failed", now);
  }
  const acted = first.parks.length + first.plan.lands.length + first.plan.checks.length > 0;
  dispatch(sim, (acted ? planOf(sim) : first).plan.dispatches, now);
  sim.tick = acted ? now + sim.world.pollSeconds / 3600 : undefined;
};

/** The dispatcher's reading of the tasks as they stand, and its plan. */
const planOf = (sim: Sim) => {
  const { rules, pipelines, world } = sim;
  const tasks = live(sim);
  const open = tasks.filter((task) => task.status === "open");
  const claimed = tasks.filter((task) => task.status === "in_progress");
  const { queue, yours } = queueFrom({
    ready: open,
    ladder: rules.ladder,
    projects: [world.project],
    epics: world.epics,
    failed: new Set(),
    now: world.now,
  });
  const active = (task: Item) => ({ task, worker: workerOf(sim, task), kind: undefined });
  const underReview = (task: Item) => isUnderReview(placementOf(sim, task));
  const held = [
    ...branchesOut(pipelines, claimed),
    ...occupancyOf(pipelines, [...claimed, ...open]),
  ];
  const offered = candidatesFrom({
    claimed: claimed.filter((task) => !underReview(task)).map(active),
    reviewing: claimed.filter(underReview).map(active),
    queue,
    committed: new Set(claimed.map((task) => task.id)),
    pipelines,
    seats: rules,
    walled: { author: new Set(), review: new Set() },
    held,
  });
  const plan = planFrom({
    workers: claimed.flatMap((task) => workerOf(sim, task) ?? []),
    outOfQuota: offered.outOfQuota,
    queue: offered.queue,
    held,
    review: offered.review,
    policy: sim.policy,
    scopes: new Map(),
    pipelines,
    placed: tasks.map((task) => ({ task, placement: placementOf(sim, task) })),
    dirty: new Set(),
    // The simulation reads no GitHub, so a pull-request landing never takes a step in it.
    pullRequests: new Map(),
  });
  return { parks: [...offered.parks.map(({ task }) => task), ...yours], plan };
};

/**
 * The `busy` holds git would read for branch tasks in the checkout. The
 * simulation runs no git, so it takes a claimed branch task with an author run
 * to have its branch out there: dispatching that author checks the branch out,
 * and the landing or requeue that ends the claim checks the operator's branch
 * out again.
 */
const branchesOut = (
  pipelines: ReadonlyMap<string, ProjectPipeline>,
  claimed: ReadonlyArray<Item>,
): ReadonlyArray<Held> =>
  claimed
    .filter(
      (task) =>
        workspaceOf(pipelines, task) === "branch" && task.runs.some((run) => run.role === "author"),
    )
    .map((task) => ({
      project: task.project,
      reason: "busy",
      detail: `${labelFor(task.id)} is checked out`,
      branch: labelFor(task.id),
    }));

/** Opens a run for each planned dispatch, on the rung a dispatch would draw. */
const dispatch = (sim: Sim, dispatches: Plan["dispatches"], now: number) => {
  // One tick's authors spread over the accounts; a reviewer draws none.
  const drawn = new Set<string>();
  for (const { task, block, role } of dispatches) {
    const authors = role === "author" ? drawn : undefined;
    const walled = { author: new Set<string>(), review: new Set<string>() };
    const rung = drawSeat(sim.rules, block, task, walled, authors);
    if (rung._tag !== "Dispatch") continue;
    const opened = started(sim.tasks.get(task.id)!, block, rung.seat, sim.rules);
    sim.tasks.set(task.id, opened);
    const runs = sim.runsBySeat[block.role];
    runs.set(rung.seat.name, (runs.get(rung.seat.name) ?? 0) + 1);
    run(sim, opened, sim.rates.agent(rung.seat.name, block.role), now);
  }
};

/** Draws how the run that just opened on `task` ends, and when. */
const run = (sim: Sim, task: Simulated, rate: AgentRate, now: number) => {
  const offers = offersAt(placementOf(sim, task), openRung(task, sim.rules));
  const event = drawOutcome(offers, rate, sim.random);
  sim.pending.set(task.id, { end: now + drawMinutes(rate, sim.random) / 60, event });
};

/** Folds `event` at the block `task` stands at, and ends the task there if it landed or parked. */
const step = (sim: Sim, task: Simulated, event: TraceEvent, now: number) => {
  const placement = placementOf(sim, task);
  const after = afterEvent(task, placement, event, sim.rules);
  sim.tasks.set(task.id, after);
  const how =
    after.status === "done" ? "landed" : after.parked !== undefined ? "parked" : undefined;
  if (how !== undefined) sim.ended.set(task.id, { at: now, node: nodeOf(placement), how });
};

/** The run that ends first; of two that end together, the task earlier in the queue's. */
const nextDue = (sim: Sim) =>
  sim.order
    .flatMap((id) => {
      const due = sim.pending.get(id);
      return due === undefined ? [] : [{ id, ...due }];
    })
    .reduce<{ readonly id: string; readonly end: number; readonly event: TraceEvent } | undefined>(
      (soonest, due) => (soonest === undefined || due.end < soonest.end ? due : soonest),
      undefined,
    );

/** Writes where each task stands at `now`, over the last frame when it is closer than the window. */
const snapshot = (sim: Sim, now: number) => {
  const standings = sim.order.map((id): Standing => {
    const end = sim.ended.get(id);
    if (end !== undefined) return { task: id, node: end.node, state: end.how };
    const placement = placementOf(sim, sim.tasks.get(id)!);
    const state: FrameState =
      placement._tag === "At"
        ? placement.state
        : placement._tag === "Parked"
          ? "parked"
          : "outside";
    return { task: id, node: nodeOf(placement), state };
  });
  const last = sim.frames.at(-1);
  if (sim.frames.length > 1 && last !== undefined && now - last.at < sim.window) sim.frames.pop();
  sim.frames.push({ at: now, standings });
};

/** How each task ended, or where it stands at the end. */
const resultOf = (sim: Sim): SimulatedRun => {
  const tasks = sim.order.map((id): SimulatedTask => {
    const task = sim.tasks.get(id)!;
    const end = sim.ended.get(id);
    const placement = placementOf(sim, task);
    return {
      id,
      title: task.title,
      landedAt: end?.how === "landed" ? hoursOf(end.at) : null,
      parkedAt: end?.how === "parked" ? hoursOf(end.at) : null,
      at: end === undefined && placement._tag === "At" ? placement.node.id : null,
    };
  });
  const count = (keep: (task: SimulatedTask) => boolean) => tasks.filter(keep).length;
  return {
    frames: sim.frames
      .map((board, index) => ({
        at: hoursOf(board.at),
        moves: movesSince(sim.frames[index - 1], board),
      }))
      .filter((frame, index) => index === 0 || frame.moves.length > 0),
    tasks,
    runsBySeat: {
      author: Object.fromEntries(sim.runsBySeat.author),
      review: Object.fromEntries(sim.runsBySeat.review),
    },
    landed: count((task) => task.landedAt !== null),
    parked: count((task) => task.parkedAt !== null),
    inFlight: count((task) => task.at !== null),
    outside: count((task) => task.landedAt === null && task.parkedAt === null && task.at === null),
  };
};

/** The tasks that have not landed or parked, in the queue's order at the start. */
/** The standings in `board` that differ from `before`'s; all of them when there is none. */
const movesSince = (before: Board | undefined, board: Board): ReadonlyArray<Standing> =>
  board.standings.filter((standing, index) => {
    const was = before?.standings[index];
    return was === undefined || was.node !== standing.node || was.state !== standing.state;
  });

const live = (sim: Sim): ReadonlyArray<Simulated> =>
  sim.order.flatMap((id) => (sim.ended.has(id) ? [] : [sim.tasks.get(id)!]));

const placementOf = (sim: Sim, task: Item): Placement => placementIn(sim.pipelines, task);

/** A pane that is still working, for a task whose run is open: it holds a slot. */
const workerOf = (sim: Sim, task: Item): Worker | undefined =>
  sim.pending.has(task.id)
    ? {
        task: task.id,
        directory: "",
        worktree: undefined,
        repository: undefined,
        state: "working",
        since: undefined,
        roles: new Map(),
      }
    : undefined;

/** The block a placement names, if any. */
const nodeOf = (placement: Placement): string | null =>
  placement._tag === "At" ? placement.stands : placement._tag === "Parked" ? placement.node : null;

const hoursOf = (hours: number): number => Math.round(hours * 100) / 100;

const roundedOrNull = (value: number | undefined): number | null =>
  value === undefined ? null : Math.round(value * 10) / 10;

/** A seeded generator of numbers in [0, 1): the same seed gives the same sequence. */
const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};
