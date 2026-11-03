/**
 * The dependency graph of tasks: one node per task, one edge from a task to
 * each task that waits for it.
 */
import { Graph, Option } from "effect";

/** `item` cannot start until `dependsOn` is resolved. */
export interface Dependency {
  readonly item: string;
  readonly dependsOn: string;
}

/** A task as the graph draws it. */
export interface GraphNode {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

/**
 * The ids of a cycle among `edges`, the first id repeated at the end, or
 * nothing when the edges are acyclic.
 */
export const cycleIn = (edges: ReadonlyArray<Dependency>): ReadonlyArray<string> | undefined => {
  const { graph, idOf } = build(
    edges.flatMap((e) => [node(e.item), node(e.dependsOn)]),
    edges,
  );
  return Option.match(Graph.findCycle(graph), {
    onNone: () => undefined,
    onSome: (cycle) => cycle.path.map(idOf),
  });
};

/** The graph as a Mermaid flowchart: an arrow runs from a task to the tasks that wait for it. */
export const dependencyMermaid = (
  nodes: ReadonlyArray<GraphNode>,
  edges: ReadonlyArray<Dependency>,
): string =>
  Graph.toMermaid(build(nodes, edges).graph, {
    direction: "LR",
    nodeLabel: (n) => `${n.id} ${n.status} - ${n.title.replaceAll('"', "'")}`,
  });

/**
 * Each of `ids` mapped to its column: 0 for an item nothing in `ids` blocks,
 * else one more than the highest column among its blockers, so every item
 * stands right of all it waits for. An edge to an id outside `ids` is left
 * out. In a cycle, the edge that closes it is left out, so every column is
 * finite.
 */
export const columnsOf = (
  ids: ReadonlyArray<string>,
  edges: ReadonlyArray<Dependency>,
): ReadonlyMap<string, number> => {
  const known = new Set(ids);
  const blockers = new Map<string, Array<string>>();
  for (const { item, dependsOn } of edges) {
    if (!known.has(item) || !known.has(dependsOn)) continue;
    blockers.set(item, [...(blockers.get(item) ?? []), dependsOn]);
  }
  const columns = new Map<string, number>();
  const visiting = new Set<string>();
  const columnOf = (id: string): number => {
    const found = columns.get(id);
    if (found !== undefined) return found;
    visiting.add(id);
    const column = Math.max(
      0,
      ...(blockers.get(id) ?? [])
        .filter((blocker) => !visiting.has(blocker))
        .map((blocker) => columnOf(blocker) + 1),
    );
    visiting.delete(id);
    columns.set(id, column);
    return column;
  };
  for (const id of ids) columnOf(id);
  return columns;
};

const node = (id: string): GraphNode => ({ id, title: "", status: "" });

/** Builds the graph; an edge to a task not in `nodes` adds that task as a bare node. */
const build = (nodes: ReadonlyArray<GraphNode>, edges: ReadonlyArray<Dependency>) => {
  const index = new Map<string, Graph.NodeIndex>();
  const graph = Graph.directed<GraphNode, string>((mutable) => {
    const place = (n: GraphNode) => {
      if (!index.has(n.id)) index.set(n.id, Graph.addNode(mutable, n));
      return index.get(n.id)!;
    };
    for (const n of nodes) place(n);
    for (const edge of edges) {
      Graph.addEdge(mutable, place(node(edge.dependsOn)), place(node(edge.item)), "blocks");
    }
  });
  const idOf = (at: Graph.NodeIndex) =>
    Option.match(Graph.getNode(graph, at), { onNone: () => `#${at}`, onSome: (n) => n.id });
  return { graph, idOf };
};
