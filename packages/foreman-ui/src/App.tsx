/**
 * The page's root: the disconnect banner, the wait for the first reading, and
 * the routes (docs/web-ui.md, "The page"): the dashboard at `/`, a project at
 * `/p/<project>`, the project's task graph at `/p/<project>/graph`, and the
 * metrics of closed agent runs at `/metrics`.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { Published } from "foreman/published-schema";
import { createContext, use, useCallback, useMemo, useState } from "react";
import { Dashboard } from "./dashboard.tsx";
import {
  MetricsPage,
  metricsQueryOf,
  metricsSearchOf,
  queryOfMetrics,
  type MetricsSearch,
} from "./metrics-page.tsx";
import { graphSearchOf, graphStateOf, searchOf, type SetGraphState } from "./graph-url.ts";
import { PipelineEditor } from "./pipeline-editor.tsx";
import { connectionAtom, readingsAtom } from "./rpc.ts";
import { TaskGraph } from "./task-graph.tsx";

/** The page. Each mount makes its own router over the browser's history. */
export const App = () => {
  const [router] = useState(makeRouter);
  return <RouterProvider router={router} />;
};

const makeRouter = () => createRouter({ routeTree, parseSearch, stringifySearch });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}

/** The newest reading, for the routes under the shell. */
const ReadingContext = createContext<Published | null>(null);

const useReading = (): Published => {
  const reading = use(ReadingContext);
  if (reading === null) throw new Error("foreman-ui: a route read the reading outside the shell");
  return reading;
};

/** The disconnect banner, and the route once the first reading came. */
const Shell = () => {
  const connection = useAtomValue(connectionAtom);
  const readings = useAtomValue(readingsAtom);
  return (
    <>
      {connection === "disconnected" ? (
        <div className="banner" data-testid="disconnected" role="status">
          Disconnected from foreman. Retrying each second…
        </div>
      ) : null}
      {AsyncResult.isSuccess(readings) ? (
        <ReadingContext value={readings.value}>
          <Outlet />
        </ReadingContext>
      ) : AsyncResult.isFailure(readings) ? (
        <div className="app">
          <p data-testid="readings-error">Could not read the fleet.</p>
        </div>
      ) : (
        <div className="app">
          <p data-testid="readings-loading" className="muted">
            Connecting…
          </p>
        </div>
      )}
    </>
  );
};

const DashboardPage = () => <Dashboard reading={useReading()} />;

const ProjectPage = () => {
  const { name } = projectRoute.useParams();
  const reading = useReading();
  const project = reading.projects.find((p) => p.name === name);
  const rows = reading.rows.filter((row) => row.project === name);
  const placements = reading.placements.filter((p) => p.project === name);
  const stopped = reading.stopped.filter((s) => s.project === name);
  return (
    <div className="app app-wide" data-testid={`project-page-${name}`}>
      <Link className="back" to="/">
        ← dashboard
      </Link>
      <header className="header">
        <h1>{name}</h1>
        <span className="muted">{project?.directory ?? "not in reading"}</span>
        <Link to="/p/$name/graph" params={{ name }} data-testid="graph-link">
          task graph →
        </Link>
      </header>
      <PipelineEditor project={name} />
      <div className="readings">
        <section data-testid="project-meta">
          <h2>Project</h2>
          {project === undefined ? (
            <p className="empty">This project is not in the current reading.</p>
          ) : (
            <ul>
              <li>tracker: {project.tracker}</li>
              <li>directory: {project.directory}</li>
              {project.unreachable !== null ? <li>unreachable: {project.unreachable}</li> : null}
            </ul>
          )}
        </section>
        <section data-testid="project-rows">
          <h2>Rows</h2>
          {rows.length === 0 ? (
            <p className="empty">No rows for this project.</p>
          ) : (
            <ul>
              {rows.map((row) => (
                <li key={`${row.view}:${row.key}`}>
                  [{row.view}] {row.label}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section data-testid="project-placements">
          <h2>Placements</h2>
          {placements.length === 0 ? (
            <p className="empty">No placements for this project.</p>
          ) : (
            <ul>
              {placements.map((p) => (
                <li key={p.key}>
                  {p.label} @ {p.stands} ({p.state})
                </li>
              ))}
            </ul>
          )}
        </section>
        {stopped.length > 0 ? (
          <section data-testid="project-stopped">
            <h2>Stopped</h2>
            <ul>
              {stopped.map((s) => (
                <li key={s.project}>{s.problems.join("; ")}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
};

/** The task graph, whose view state is the route's search params. */
const GraphPage = () => {
  const { name } = graphRoute.useParams();
  const search = graphRoute.useSearch();
  const navigate = graphRoute.useNavigate();
  const state = useMemo(() => graphStateOf(search), [search]);
  // `replace`: a filter or a fold is not a step the Back button should undo.
  const setState = useCallback<SetGraphState>(
    (change) =>
      void navigate({ search: (now) => searchOf(change(graphStateOf(now))), replace: true }),
    [navigate],
  );
  return (
    <div className="app app-wide" data-testid={`graph-page-${name}`}>
      <Link className="back" to="/p/$name" params={{ name }}>
        ← {name}
      </Link>
      <header className="header">
        <h1>{name}</h1>
        <span className="muted">task graph</span>
      </header>
      <TaskGraph project={name} state={state} setState={setState} />
    </div>
  );
};

const MetricsRoutePage = () => {
  const query = metricsRoute.useSearch();
  const search = useMemo(() => metricsSearchOf(query), [query]);
  const navigate = metricsRoute.useNavigate();
  // `replace`: a filter is not a step the Back button should undo.
  const setSearch = useCallback(
    (next: MetricsSearch) => void navigate({ search: queryOfMetrics(next), replace: true }),
    [navigate],
  );
  return <MetricsPage search={search} setSearch={setSearch} />;
};

const NotFound = () => (
  <div className="app" data-testid="not-found">
    <p>No page at this address.</p>
    <Link to="/">← dashboard</Link>
  </div>
);

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFound });

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DashboardPage,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$name",
  component: ProjectPage,
});

const graphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$name/graph",
  validateSearch: graphSearchOf,
  component: GraphPage,
});

const metricsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/metrics",
  validateSearch: metricsQueryOf,
  component: MetricsRoutePage,
});

const routeTree = rootRoute.addChildren([dashboardRoute, projectRoute, graphRoute, metricsRoute]);

// The query is flat strings, lists joined with commas, so a link stays
// readable and a typed value stays text: each route decodes its own keys
// (graph-url.ts). The router's default would JSON-encode each value and read
// "123" as a number.
const parseSearch = (text: string): Record<string, unknown> =>
  Object.fromEntries(new URLSearchParams(text));

const stringifySearch = (search: Record<string, unknown>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string") params.set(key, value);
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
};
