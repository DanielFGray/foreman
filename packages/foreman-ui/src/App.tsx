import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { Published } from "foreman/published-schema";
import { Dashboard } from "./dashboard.tsx";
import { PipelineEditor } from "./pipeline-editor.tsx";
import { connectionAtom, readingsAtom } from "./rpc.ts";
import { graphPath, routeOf } from "./route.ts";
import { TaskGraph } from "./task-graph.tsx";

const ProjectReadings = ({
  name,
  reading,
}: {
  readonly name: string;
  readonly reading: Published;
}) => {
  const project = reading.projects.find((p) => p.name === name);
  const rows = reading.rows.filter((row) => row.project === name);
  const placements = reading.placements.filter((p) => p.project === name);
  const stopped = reading.stopped.filter((s) => s.project === name);
  return (
    <div className="app app-wide" data-testid={`project-page-${name}`}>
      <a className="back" href="/">
        ← projects
      </a>
      <header className="header">
        <h1>{name}</h1>
        <span className="muted">{project?.directory ?? "not in reading"}</span>
        <a href={graphPath(name)} data-testid="graph-link">
          task graph →
        </a>
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

const ProjectGraph = ({ name }: { readonly name: string }) => (
  <div className="app app-wide" data-testid={`graph-page-${name}`}>
    <a className="back" href={`/p/${encodeURIComponent(name)}`}>
      ← {name}
    </a>
    <header className="header">
      <h1>{name}</h1>
      <span className="muted">task graph</span>
    </header>
    <TaskGraph project={name} />
  </div>
);

const ReadingBody = ({ reading }: { readonly reading: Published }) => {
  const route = routeOf(globalThis.location.pathname);
  switch (route._tag) {
    case "project":
      return <ProjectReadings name={route.name} reading={reading} />;
    case "graph":
      return <ProjectGraph name={route.name} />;
    case "projects":
      return <Dashboard reading={reading} />;
  }
};

/** Root page: disconnect banner and the route for the current path. */
export const App = () => {
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
        <ReadingBody reading={readings.value} />
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
