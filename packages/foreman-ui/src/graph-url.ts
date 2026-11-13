/**
 * The task graph's view state as the URL query holds it, so a reload after a
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

/** Reads the state from `location.search`. An unknown status is dropped. */
export const graphStateOf = (search: string): GraphUrlState => {
  const params = new URLSearchParams(search);
  const status = params.get("status");
  return {
    statuses: status === null ? GRAPH_STATUSES : inOrder(listOf(status).filter(S.is(TaskState))),
    query: params.get("q") ?? "",
    folded: new Set(listOf(params.get("fold") ?? "")),
    picked: listOf(params.get("pick") ?? ""),
  };
};

/** The query for the state, leaving out each field at its default. */
export const searchOf = (state: GraphUrlState): string => {
  const params = new URLSearchParams();
  const statuses = inOrder(state.statuses);
  if (statuses.join(",") !== inOrder(GRAPH_STATUSES).join(","))
    params.set("status", statuses.join(","));
  if (state.query !== "") params.set("q", state.query);
  if (state.folded.size > 0) params.set("fold", [...state.folded].join(","));
  if (state.picked.length > 0) params.set("pick", state.picked.join(","));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
};

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

const listOf = (text: string): ReadonlyArray<string> =>
  text.split(",").filter((part) => part !== "");

const inOrder = (statuses: ReadonlyArray<TaskState>): ReadonlyArray<TaskState> =>
  TaskState.literals.filter((status) => statuses.includes(status));
