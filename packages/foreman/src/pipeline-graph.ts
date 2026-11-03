// A project's unfinished work as a graph, for the pipeline pane to draw: each
// task and epic in a column right of the items it waits for, the grant that
// covers it, and the steps the project's pipeline gates on. The pane lays
// nothing out and picks no steps itself: dropping a card on the board grants
// it `grantSteps`.
import { columnsOf, type Dependency, type Item } from "tasks";
import type { Pipeline } from "./pipeline.ts";
import {
  type Grant,
  modeFor,
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
  /** The grant that covers it, if one does. */
  readonly grant: CoveringGrant | null;
}

export interface CoveringGrant {
  readonly scope: string;
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
 * The project's graph. An item's grant is the first grant that names it as
 * its scope, has admitted it, or reaches it through its scope, the order
 * `permit` reads them in.
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
  const gated = new Set(
    pipeline.nodes.flatMap((node) => (node.kind === "gate" ? [node.step] : [])),
  );
  const steps = STEPS.filter((step) => gated.has(step)).map((step) => ({
    step,
    mode: modeFor(policy, project, step),
  }));
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
      grant: coveringOf(policy.grants, scopes, item.id),
    })),
    edges,
    steps,
    grantSteps: steps.filter(({ mode }) => mode !== "on").map(({ step }) => step),
  };
};

const coveringOf = (
  grants: ReadonlyArray<Grant>,
  scopes: Scopes,
  id: string,
): CoveringGrant | null => {
  const grant = grants.find(
    (g) => g.scope === id || g.admitted.includes(id) || scopes.get(g.scope)?.has(id),
  );
  return grant === undefined
    ? null
    : {
        scope: grant.scope,
        steps: grant.steps,
        left:
          grant.remaining === undefined
            ? null
            : Math.max(0, grant.remaining - grant.admitted.length),
      };
};

const FINISHED: ReadonlySet<string> = new Set(["done", "canceled"]);
