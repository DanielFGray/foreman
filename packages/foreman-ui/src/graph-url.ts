/**
 * The task graph's view state and its search params, so a reload after a
 * reconnect keeps what the operator set (docs/web-ui.md, "The task graph").
 */
import { Schema as S } from "effect";
import { GRAPH_STATUSES } from "foreman/pipeline-graph-view";
import { TaskState } from "tasks/item";

export interface GraphUrlState {
  /** In the order `TaskState` lists them, so equal sets give equal keys. */
  readonly statuses: ReadonlyArray<TaskState>;
  readonly query: string;
  readonly folded: ReadonlySet<string>;
  /** Oldest first; the last one is the detail panel's. */
  readonly picked: ReadonlyArray<string>;
}

/**
 * The graph route's search params as the URL holds them: lists joined with
 * commas, and a field at its default left out.
 */
export interface GraphSearch {
  readonly status?: string;
  readonly q?: string;
  readonly fold?: string;
  readonly pick?: string;
}

/** Keeps the graph's own keys of a parsed query (the route's `validateSearch`). */
export const graphSearchOf = (query: Record<string, unknown>): GraphSearch =>
  Object.fromEntries(
    SEARCH_KEYS.flatMap((key) => (typeof query[key] === "string" ? [[key, query[key]]] : [])),
  );

/** Reads the state from the search params. An unknown status is dropped. */
export const graphStateOf = (search: GraphSearch): GraphUrlState => ({
  statuses:
    search.status === undefined
      ? GRAPH_STATUSES
      : inOrder(listOf(search.status).filter(S.is(TaskState))),
  query: search.q ?? "",
  folded: new Set(listOf(search.fold ?? "")),
  picked: listOf(search.pick ?? ""),
});

/** The search params for the state, leaving out each field at its default. */
export const searchOf = (state: GraphUrlState): GraphSearch => {
  const statuses = inOrder(state.statuses).join(",");
  return {
    ...(statuses === inOrder(GRAPH_STATUSES).join(",") ? {} : { status: statuses }),
    ...(state.query === "" ? {} : { q: state.query }),
    ...(state.folded.size === 0 ? {} : { fold: [...state.folded].join(",") }),
    ...(state.picked.length === 0 ? {} : { pick: state.picked.join(",") }),
  };
};

/** A change to the state, written to the URL. */
export type SetGraphState = (change: (state: GraphUrlState) => GraphUrlState) => void;

/** Picks `id`, or unpicks it when it is picked already. */
export const togglePick = (state: GraphUrlState, id: string): GraphUrlState => ({
  ...state,
  picked: state.picked.includes(id)
    ? state.picked.filter((one) => one !== id)
    : [...state.picked, id],
});

/** Folds an epic, or unfolds it when it is folded. */
export const toggleFold = (state: GraphUrlState, id: string): GraphUrlState => {
  const folded = new Set(state.folded);
  if (!folded.delete(id)) folded.add(id);
  return { ...state, folded };
};

/** Shows a status, or hides it when it is shown. */
export const toggleStatus = (state: GraphUrlState, status: TaskState): GraphUrlState => ({
  ...state,
  statuses: state.statuses.includes(status)
    ? state.statuses.filter((one) => one !== status)
    : inOrder([...state.statuses, status]),
});

const SEARCH_KEYS = ["status", "q", "fold", "pick"] as const;

const listOf = (text: string): ReadonlyArray<string> =>
  text.split(",").filter((part) => part !== "");

const inOrder = (statuses: ReadonlyArray<TaskState>): ReadonlyArray<TaskState> =>
  TaskState.literals.filter((status) => statuses.includes(status));
