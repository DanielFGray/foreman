/**
 * A project's tasks and epics as one 2D graph on `/p/<project>/graph`
 * (docs/web-ui.md, "The task graph"): status filters, search, epics that fold,
 * picked cards sent through with PolicyGrant, and a detail panel.
 */
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { GraphItemView, GraphView } from "foreman/pipeline-graph-view";
import type { Flow } from "foreman/pipeline-view";
import { useMemo, useState } from "react";
import { TaskState } from "tasks/item";
import {
  type DrawnEdge,
  type DrawnNode,
  projectGraph,
  type Projection,
} from "./graph-projection.ts";
import {
  type GraphUrlState,
  type SetGraphState,
  toggleFold,
  togglePick,
  toggleStatus,
} from "./graph-url.ts";
import { GRAPH_KEYS, graphAtom, UiRpc } from "./rpc.ts";
import { useFlow } from "./screen.ts";
import { reasonOf } from "./reason.ts";

/** The graph of `project`, with the view state its route keeps in the URL. */
export const TaskGraph = ({
  project,
  state,
  setState,
}: {
  readonly project: string;
  readonly state: GraphUrlState;
  readonly setState: SetGraphState;
}) => {
  const atom = graphAtom(project)(state.statuses.join(","));
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const flow = useFlow();
  return (
    <div className="task-graph" data-testid="task-graph">
      <Filters state={state} setState={setState} refresh={refresh} />
      {AsyncResult.isSuccess(result) ? (
        <LoadedGraph view={result.value} state={state} setState={setState} flow={flow} />
      ) : AsyncResult.isFailure(result) ? (
        <p className="problem" role="alert">
          Could not read the graph: {Cause.pretty(result.cause)}
        </p>
      ) : (
        <p className="muted">Reading the graph…</p>
      )}
    </div>
  );
};

const Filters = ({
  state,
  setState,
  refresh,
}: {
  readonly state: GraphUrlState;
  readonly setState: SetGraphState;
  readonly refresh: () => void;
}) => (
  <div className="graph-filters">
    <fieldset className="graph-statuses">
      <legend className="visually-hidden">Statuses shown</legend>
      {TaskState.literals.map((status) => (
        <label key={status}>
          <input
            type="checkbox"
            checked={state.statuses.includes(status)}
            onChange={() => setState((now) => toggleStatus(now, status))}
            data-testid={`graph-status-${status}`}
          />
          {status.replace("_", " ")}
        </label>
      ))}
    </fieldset>
    <input
      type="search"
      placeholder="Search id or title"
      value={state.query}
      onChange={(event) => {
        const query = event.currentTarget.value;
        setState((now) => ({ ...now, query }));
      }}
      data-testid="graph-search"
    />
    <button type="button" onClick={refresh} data-testid="graph-refresh">
      Refresh
    </button>
  </div>
);

const LoadedGraph = ({
  view,
  state,
  setState,
  flow,
}: {
  readonly view: GraphView;
  readonly state: GraphUrlState;
  readonly setState: SetGraphState;
  readonly flow: Flow;
}) => {
  const projection = useMemo(
    () => projectGraph(view, { folded: state.folded, query: state.query }),
    [view, state.folded, state.query],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const grant = useAtomSet(UiRpc.mutation("PolicyGrant"), { mode: "promiseExit" });
  const revoke = useAtomSet(UiRpc.mutation("PolicyRevoke"), { mode: "promiseExit" });
  const picked = state.picked.flatMap((id) => view.items.filter((item) => item.id === id));

  const sendThrough = async () => {
    setProblem(null);
    for (const item of picked) {
      const exit = await grant({
        payload: { scope: item.id, steps: view.grantSteps, remaining: Option.none() },
        reactivityKeys: GRAPH_KEYS,
      });
      if (Exit.isFailure(exit)) return setProblem(`${item.id}: ${reasonOf(exit.cause)}`);
    }
    setState((now) => ({ ...now, picked: [] }));
  };
  const revokeScope = async (scope: string) => {
    setProblem(null);
    const exit = await revoke({ payload: { scope }, reactivityKeys: GRAPH_KEYS });
    if (Exit.isFailure(exit)) setProblem(`${scope}: ${reasonOf(exit.cause)}`);
  };

  const last = picked.at(-1);
  return (
    <>
      <div className="graph-toolbar">
        <span className="muted" data-testid="graph-steps">
          {stepsLine(view)}
        </span>
        {view.grantSteps.length > 0 ? (
          <button
            type="button"
            disabled={picked.length === 0}
            onClick={() => void sendThrough()}
            data-testid="graph-send"
          >
            {picked.length > 1 ? `Send ${picked.length} through` : "Send through"}
          </button>
        ) : null}
        {picked.length > 0 ? (
          <button
            type="button"
            onClick={() => setState((now) => ({ ...now, picked: [] }))}
            data-testid="graph-clear"
          >
            Clear picks
          </button>
        ) : null}
        {problem === null ? null : (
          <span className="problem" role="alert" data-testid="graph-problem">
            {problem}
          </span>
        )}
      </div>
      <div className="graph-body">
        <div className="graph-canvas" data-testid="graph-canvas">
          {projection.nodes.length === 0 ? (
            <p className="empty">Nothing in these statuses matches.</p>
          ) : (
            <GraphDrawing
              projection={projection}
              picked={state.picked}
              flow={flow}
              onPick={(id) => setState((now) => togglePick(now, id))}
              onFold={(id) => setState((now) => toggleFold(now, id))}
            />
          )}
        </div>
        {last === undefined ? null : (
          <Detail
            item={last}
            view={view}
            inside={projection.inside.get(last.id) ?? 0}
            onShow={(id) =>
              setState((now) => ({
                ...now,
                picked: [...now.picked.filter((one) => one !== id), id],
              }))
            }
            onRevoke={(scope) => void revokeScope(scope)}
          />
        )}
      </div>
    </>
  );
};

const CARD_W = 220;
const CARD_H = 64;
/** The gap between columns, where the edges run. */
const ALONG = 64;
/** The gap between cards in one column. */
const ACROSS = 14;
const PAD = 16;

/** Where a node's card sits: columns run left to right across, top to bottom down. */
const cornerOf = (node: DrawnNode, flow: Flow): readonly [number, number] =>
  flow === "across"
    ? [PAD + node.column * (CARD_W + ALONG), PAD + node.row * (CARD_H + ACROSS)]
    : [PAD + node.row * (CARD_W + ACROSS), PAD + node.column * (CARD_H + ALONG)];

const GraphDrawing = ({
  projection,
  picked,
  flow,
  onPick,
  onFold,
}: {
  readonly projection: Projection;
  readonly picked: ReadonlyArray<string>;
  readonly flow: Flow;
  readonly onPick: (id: string) => void;
  readonly onFold: (id: string) => void;
}) => {
  const corners = new Map(projection.nodes.map((node) => [node.item.id, cornerOf(node, flow)]));
  const width = Math.max(...[...corners.values()].map(([x]) => x)) + CARD_W + PAD;
  const height = Math.max(...[...corners.values()].map(([, y]) => y)) + CARD_H + PAD;
  return (
    <svg width={width} height={height} role="img" aria-label="Task graph">
      <defs>
        <marker
          id="graph-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" className="graph-arrowhead" />
        </marker>
      </defs>
      {projection.edges.map((edge) => (
        <Edge key={`${edge.from}>${edge.to}`} edge={edge} corners={corners} flow={flow} />
      ))}
      {projection.nodes.map((node) => (
        <Card
          key={node.item.id}
          node={node}
          corner={corners.get(node.item.id) ?? [0, 0]}
          picked={picked.includes(node.item.id)}
          onPick={onPick}
          onFold={onFold}
        />
      ))}
    </svg>
  );
};

const Edge = ({
  edge,
  corners,
  flow,
}: {
  readonly edge: DrawnEdge;
  readonly corners: ReadonlyMap<string, readonly [number, number]>;
  readonly flow: Flow;
}) => {
  const from = corners.get(edge.from);
  const to = corners.get(edge.to);
  if (from === undefined || to === undefined) return null;
  const [ax, ay, bx, by] =
    flow === "across"
      ? [from[0] + CARD_W, from[1] + CARD_H / 2, to[0], to[1] + CARD_H / 2]
      : [from[0] + CARD_W / 2, from[1] + CARD_H, to[0] + CARD_W / 2, to[1]];
  const bend = flow === "across" ? [ALONG / 2, 0] : [0, ALONG / 2];
  const path = `M${ax},${ay} C${ax + bend[0]!},${ay + bend[1]!} ${bx - bend[0]!},${by - bend[1]!} ${bx},${by}`;
  return (
    <g className={edge.resolved ? "graph-edge resolved" : "graph-edge"}>
      <path d={path} markerEnd="url(#graph-arrow)" />
      {edge.count > 1 ? (
        <text x={(ax + bx) / 2} y={(ay + by) / 2 - 4} className="graph-edge-count">
          ×{edge.count}
        </text>
      ) : null}
    </g>
  );
};

const Card = ({
  node,
  corner,
  picked,
  onPick,
  onFold,
}: {
  readonly node: DrawnNode;
  readonly corner: readonly [number, number];
  readonly picked: boolean;
  readonly onPick: (id: string) => void;
  readonly onFold: (id: string) => void;
}) => {
  const { item } = node;
  const classes = [
    "graph-card",
    item.type,
    `status-${item.status}`,
    picked ? "picked" : "",
    node.context ? "context" : "",
    item.grant === null ? "" : "granted",
  ].filter((name) => name !== "");
  return (
    <g
      className={classes.join(" ")}
      transform={`translate(${corner[0]},${corner[1]})`}
      role="button"
      tabIndex={0}
      aria-pressed={picked}
      aria-label={`${item.id} ${item.title}`}
      data-testid={`graph-card-${item.id}`}
      onClick={() => onPick(item.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onPick(item.id);
      }}
    >
      <rect width={CARD_W} height={CARD_H} rx={6} />
      <text x={10} y={18} className="graph-card-meta">
        {item.id} · {item.status.replace("_", " ")} · P{item.priority}
      </text>
      <text x={10} y={37} className="graph-card-title">
        {clip(item.title, 30)}
      </text>
      <text x={10} y={55} className="graph-card-grant">
        {item.grant === null
          ? ""
          : item.grant.scope === item.id
            ? "granted"
            : `granted by ${item.grant.scope}`}
      </text>
      {item.type === "epic" && node.members > 0 ? (
        <g
          className="graph-fold"
          role="button"
          tabIndex={0}
          aria-label={node.hidden > 0 ? `Unfold ${item.id}` : `Fold ${item.id}`}
          data-testid={`graph-fold-${item.id}`}
          transform={`translate(${CARD_W - 64},${CARD_H - 22})`}
          onClick={(event) => {
            event.stopPropagation();
            onFold(item.id);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onFold(item.id);
          }}
        >
          <rect width={56} height={18} rx={4} />
          <text x={28} y={13} textAnchor="middle">
            {node.hidden > 0 ? `▸ ${node.hidden}` : `▾ ${node.members}`}
          </text>
        </g>
      ) : null}
    </g>
  );
};

const Detail = ({
  item,
  view,
  inside,
  onShow,
  onRevoke,
}: {
  readonly item: GraphItemView;
  readonly view: GraphView;
  readonly inside: number;
  readonly onShow: (id: string) => void;
  readonly onRevoke: (scope: string) => void;
}) => {
  const waitedOnBy = view.items.filter((other) => other.waitsFor.includes(item.id));
  const link = (id: string) => (
    <button type="button" className="link" onClick={() => onShow(id)}>
      {id}
    </button>
  );
  return (
    <aside className="graph-detail" data-testid="graph-detail">
      <h2>{item.title}</h2>
      <dl>
        <dt>id</dt>
        <dd>{item.id}</dd>
        <dt>type</dt>
        <dd>{item.type}</dd>
        <dt>status</dt>
        <dd>{item.status.replace("_", " ")}</dd>
        <dt>priority</dt>
        <dd>{item.priority}</dd>
        {item.parent === null ? null : (
          <>
            <dt>epic</dt>
            <dd>{link(item.parent)}</dd>
          </>
        )}
        <dt>grant</dt>
        <dd data-testid="graph-detail-grant">
          {item.grant === null
            ? "none"
            : `${item.grant.steps.join(", ")} from ${item.grant.scope}${item.grant.left === null ? "" : `, ${item.grant.left} left`}`}
        </dd>
      </dl>
      {item.grant === null ? null : (
        <button
          type="button"
          onClick={() => onRevoke(item.grant!.scope)}
          data-testid="graph-revoke"
        >
          {item.grant.scope === item.id ? "Revoke" : `Revoke ${item.grant.scope}, the whole epic`}
        </button>
      )}
      <h3>Waits for</h3>
      {item.waitsFor.length === 0 ? (
        <p className="empty">nothing unfinished</p>
      ) : (
        <ul>
          {item.waitsFor.map((id) => (
            <li key={id}>{link(id)}</li>
          ))}
        </ul>
      )}
      <h3>Waited on by</h3>
      {waitedOnBy.length === 0 ? (
        <p className="empty">nothing shown</p>
      ) : (
        <ul>
          {waitedOnBy.map((other) => (
            <li key={other.id}>
              {link(other.id)} {other.title}
            </li>
          ))}
        </ul>
      )}
      {inside > 0 ? (
        <p className="muted">
          {inside} {inside === 1 ? "dependency is" : "dependencies are"} inside this folded epic.
          Unfold it to see them.
        </p>
      ) : null}
    </aside>
  );
};

/** What the pipeline gates, and what a grant gives. */
const stepsLine = (view: GraphView): string => {
  const gated = view.steps.map(({ step, mode }) => `${step} ${mode}`).join(" · ");
  const gives =
    view.grantSteps.length === 0
      ? "every gated step is on, so a grant changes nothing"
      : `a grant gives ${view.grantSteps.join(", ")}`;
  return gated === "" ? gives : `${gated} — ${gives}`;
};

const clip = (text: string, length: number): string =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;
