/**
 * What the task graph draws of a `GraphView`: epics folded into one node,
 * items the search keeps, edges merged between the nodes drawn, and each node
 * placed by foreman's `placeGraph` (docs/web-ui.md, "The task graph").
 */
import { placeGraph } from "foreman/pipeline-graph";
import { FINISHED, type GraphItemView, type GraphView } from "foreman/pipeline-graph-view";

/** What the operator set: the folded epics and the search text. */
export interface GraphLens {
  readonly folded: ReadonlySet<string>;
  readonly query: string;
}

/** A node the graph draws: an item, or a folded epic that stands for its family. */
export interface DrawnNode {
  readonly item: GraphItemView;
  readonly column: number;
  readonly row: number;
  /** Kept only as an ancestor of a search match, so drawn faded. */
  readonly context: boolean;
  /** The shown items a folded epic stands for; 0 when unfolded or for a task. */
  readonly hidden: number;
  /** The shown items whose parent chain reaches it: an epic's family less itself. */
  readonly members: number;
}

/** One or more dependencies between two drawn nodes: `to` waits for `from`. */
export interface DrawnEdge {
  readonly from: string;
  readonly to: string;
  readonly count: number;
  /** Every dependency under it has a finished blocker. */
  readonly resolved: boolean;
}

export interface Projection {
  readonly nodes: ReadonlyArray<DrawnNode>;
  readonly edges: ReadonlyArray<DrawnEdge>;
  /** For each folded epic, how many dependencies join two items inside it. */
  readonly inside: ReadonlyMap<string, number>;
}

/**
 * Folds, filters and places the graph. A search match keeps its ancestors as
 * context and unfolds them, so every match is drawn. A folded epic stands for
 * each item under it; an epic folded inside another folded one is drawn as the
 * outer one.
 */
export const projectGraph = (view: GraphView, lens: GraphLens): Projection => {
  const byId = new Map(view.items.map((item) => [item.id, item]));
  const parentOf = (id: string): string | undefined => {
    const parent = byId.get(id)?.parent ?? undefined;
    return parent !== undefined && byId.get(parent)?.type === "epic" ? parent : undefined;
  };
  const ancestorsOf = (id: string): ReadonlyArray<string> => {
    const chain: Array<string> = [];
    for (let at = parentOf(id); at !== undefined && !chain.includes(at); at = parentOf(at)) {
      chain.push(at);
    }
    return chain;
  };

  const query = lens.query.trim().toLowerCase();
  const matches =
    query === ""
      ? undefined
      : new Set(view.items.filter((item) => matchesQuery(item, query)).map((item) => item.id));
  const kept = new Set(matches ?? byId.keys());
  const unfolded = new Set<string>();
  for (const id of matches ?? []) {
    for (const ancestor of ancestorsOf(id)) {
      kept.add(ancestor);
      unfolded.add(ancestor);
    }
  }
  const folded = (id: string) => lens.folded.has(id) && !unfolded.has(id);
  // The outermost folded ancestor draws an item; an item with none draws itself.
  const drawnAs = (id: string): string => ancestorsOf(id).findLast(folded) ?? id;

  const members = new Map<string, number>();
  const hidden = new Map<string, number>();
  for (const id of kept) {
    for (const ancestor of ancestorsOf(id)) members.set(ancestor, (members.get(ancestor) ?? 0) + 1);
    const as = drawnAs(id);
    if (as !== id) hidden.set(as, (hidden.get(as) ?? 0) + 1);
  }

  const merged = new Map<string, { from: string; to: string; count: number; resolved: boolean }>();
  const inside = new Map<string, number>();
  for (const edge of view.edges) {
    if (!kept.has(edge.item) || !kept.has(edge.dependsOn)) continue;
    const from = drawnAs(edge.dependsOn);
    const to = drawnAs(edge.item);
    if (from === to) {
      inside.set(from, (inside.get(from) ?? 0) + 1);
      continue;
    }
    const resolved = FINISHED.has(byId.get(edge.dependsOn)?.status ?? "");
    const key = `${from}\u0000${to}`;
    const before = merged.get(key);
    merged.set(
      key,
      before === undefined
        ? { from, to, count: 1, resolved }
        : { ...before, count: before.count + 1, resolved: before.resolved && resolved },
    );
  }
  const edges = [...merged.values()];

  const drawn = view.items.filter((item) => kept.has(item.id) && drawnAs(item.id) === item.id);
  const placed = placeGraph(
    drawn.map((item) => ({ item, id: item.id, priority: item.priority, parent: item.parent })),
    edges.map((edge) => ({ item: edge.to, dependsOn: edge.from })),
  );
  return {
    nodes: placed.map(({ item, column, row }) => ({
      item,
      column,
      row,
      context: matches !== undefined && !matches.has(item.id),
      hidden: hidden.get(item.id) ?? 0,
      members: members.get(item.id) ?? 0,
    })),
    edges,
    inside,
  };
};

const matchesQuery = (item: GraphItemView, query: string): boolean =>
  item.id.toLowerCase().includes(query) || item.title.toLowerCase().includes(query);
