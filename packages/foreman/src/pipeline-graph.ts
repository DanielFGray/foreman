// A project's unfinished work as a graph, for the Foreman pane to draw: each
// task and epic in a column right of the items it waits for, the grant that
// covers it, and the steps the project's pipeline gates on. The pane lays
// nothing out and picks no steps itself: dropping a card on the board grants
// it `grantSteps`.
import { columnsOf, type Dependency, type Item } from "tasks";
import type { Pipeline } from "./pipeline.ts";
import {
  type Grant,
  modeFor,
  permit,
  type Policy,
  type Scopes,
  type Step,
  STEPS,
  type StepMode,
} from "./policy.ts";

export interface GraphReport {
  readonly project: string;
  readonly items: ReadonlyArray<GraphItem>;
  /** The edges between shown items; `item` waits for `dependsOn`. */
  readonly edges: ReadonlyArray<Dependency>;
  /** Each step a gate in the project's pipeline names, with its mode for the project. */
  readonly steps: ReadonlyArray<{ readonly step: Step; readonly mode: StepMode }>;
  /** The steps a grant from the pane gives: the gated steps that are not on. */
  readonly grantSteps: ReadonlyArray<Step>;
}

export interface GraphItem {
  readonly id: string;
  readonly title: string;
  readonly type: "task" | "epic";
  readonly status: string;
  readonly priority: number;
  readonly parent: string | null;
  /** 0 for an item no shown item blocks; else one past its furthest shown blocker. */
  readonly column: number;
  /** Its place within the column, from 0 at the top. */
  readonly row: number;
  /** Every unfinished item it waits for, shown or not. */
  readonly waitsFor: ReadonlyArray<string>;
  /** The grant that lets the dispatcher take some of `grantSteps` for it, if one does. */
  readonly grant: CoveringGrant | null;
}

export interface CoveringGrant {
  readonly scope: string;
  /** For a task, the steps of `grantSteps` it lets the dispatcher take; for an epic, the grant's steps. */
  readonly steps: ReadonlyArray<Step>;
  /** How many more tasks the grant admits, when it has a count. */
  readonly left: number | null;
}

/** What `graphReport` reads. */
export interface GraphWorld {
  readonly project: string;
  /** The project's open and in-progress tasks and epics. */
  readonly items: ReadonlyArray<Item>;
  /** Every dependency from the project's items. */
  readonly dependencies: ReadonlyArray<Dependency>;
  /** The status of each blocker the edges name, in any project. */
  readonly statusOf: (id: string) => string | undefined;
  readonly policy: Policy;
  readonly scopes: Scopes;
  readonly pipeline: Pipeline;
}

/**
 * The project's graph, with the grant that covers each item (`coveringOf`).
 */
export const graphReport = (world: GraphWorld): GraphReport => {
  const { project, items, dependencies, statusOf, policy, scopes, pipeline } = world;
  const shown = new Set(items.map((item) => item.id));
  const unfinished = dependencies.filter(
    (edge) => !FINISHED.has(statusOf(edge.dependsOn) ?? "done"),
  );
  const edges = unfinished.filter((edge) => shown.has(edge.item) && shown.has(edge.dependsOn));
  const columns = columnsOf(
    items.map((item) => item.id),
    edges,
  );
  const ordered = [...items].sort(
    (a, b) =>
      a.priority - b.priority ||
      (a.parent ?? a.id).localeCompare(b.parent ?? b.id) ||
      a.id.localeCompare(b.id),
  );
  const rows = new Map<string, number>();
  const filled = new Map<number, number>();
  for (const item of ordered) {
    const column = columns.get(item.id) ?? 0;
    rows.set(item.id, filled.get(column) ?? 0);
    filled.set(column, (filled.get(column) ?? 0) + 1);
  }
  const { steps, grantSteps } = gatedSteps(pipeline, policy, project);
  return {
    project,
    items: ordered.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      status: item.status,
      priority: item.priority,
      parent: item.parent ?? null,
      column: columns.get(item.id) ?? 0,
      row: rows.get(item.id) ?? 0,
      waitsFor: unfinished.filter((edge) => edge.item === item.id).map((edge) => edge.dependsOn),
      grant: coveringOf(policy, scopes, item, grantSteps),
    })),
    edges,
    steps,
    grantSteps,
  };
};

/**
 * Each step a gate in the pipeline names, with its mode for the project, and
 * the steps a grant from a pane gives: the gated steps that are not on. When
 * every gated step is on, a grant gives nothing, so a pane takes no drop.
 */
export const gatedSteps = (
  pipeline: Pipeline,
  policy: Policy,
  project: string,
): Pick<GraphReport, "steps" | "grantSteps"> => {
  const gated = new Set(
    pipeline.nodes.flatMap((node) => (node.kind === "gate" ? [node.step] : [])),
  );
  const steps = STEPS.filter((step) => gated.has(step)).map((step) => ({
    step,
    mode: modeFor(policy, project, step),
  }));
  return { steps, grantSteps: steps.filter(({ mode }) => mode !== "on").map(({ step }) => step) };
};

/**
 * The grant that lets the dispatcher take `grantSteps` for an item. For a
 * task it is what `permit` answers for each step, so a spent count or a grant
 * on other steps marks nothing. An epic is never dispatched itself, so its
 * grant is the one on its own id, which is the one a revoke on its card
 * removes.
 */
export const coveringOf = (
  policy: Policy,
  scopes: Scopes,
  item: Item,
  grantSteps: ReadonlyArray<Step>,
): CoveringGrant | null => {
  const covering = (grant: Grant, steps: ReadonlyArray<Step>): CoveringGrant => ({
    scope: grant.scope,
    steps,
    left:
      grant.remaining === undefined ? null : Math.max(0, grant.remaining - grant.admitted.length),
  });
  if (item.type === "epic") {
    const own = policy.grants.find((grant) => grant.scope === item.id);
    return own === undefined ? null : covering(own, own.steps);
  }
  const granted = grantSteps.flatMap((step) => {
    const answer = permit(policy, scopes, item, step);
    return answer._tag === "Granted" ? [{ step, scope: answer.scope }] : [];
  });
  const grant = policy.grants.find((one) => one.scope === granted[0]?.scope);
  return grant === undefined
    ? null
    : covering(
        grant,
        granted.map(({ step }) => step),
      );
};

const FINISHED: ReadonlySet<string> = new Set(["done", "canceled"]);
