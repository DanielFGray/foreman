/**
 * The dashboard at `/`: the fleet's state and controls, every row the
 * operator may act on with its actions, and one line per project
 * (docs/web-ui.md, "The dashboard"). It reads only the `Readings` stream; a
 * control's effect shows in the next reading.
 */
import { useAtomSet } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { Exit, Option } from "effect";
import type { Published, PublishedRow } from "foreman/published-schema";
import type { Policy } from "foreman/policy";
import type { RowAction } from "foreman/ui-contract";
import {
  ACTION_HELP,
  actionNamed,
  commandName,
  INTERVENTIONS,
  KEY_ONLY_ACTIONS,
  type Action,
  type Intervention,
} from "foreman/view-names";
import { useEffect, useState, type FormEvent } from "react";
import { bytesLabel, dashboardOf, type DispatcherLine, type ProjectLine } from "./dashboard.ts";
import { reasonOf } from "./reason.ts";
import { UiRpc } from "./rpc.ts";

/**
 * Key-only actions that ask before they run: on a phone a stray tap would
 * return a task to the queue, close it, drop its branch or cancel it.
 */
const ASKS_FIRST: ReadonlySet<Action> = new Set(["release", "close", "requeueFresh", "cancel"]);

/** Sections the dashboard opens by default; the others are history or accounts. */
const OPEN_SECTIONS = new Set(["attention", "working", "review"]);

export const Dashboard = ({ reading }: { readonly reading: Published }) => {
  const now = useNow(5_000);
  const shown = dashboardOf(reading, now);
  const rungs = [...new Set(reading.accounts.flatMap((account) => account.rungs))].sort();
  return (
    <div className="app app-wide" data-testid="dashboard">
      <FleetHeader reading={reading} dispatcher={shown.dispatcher} memory={shown.memory} />
      {shown.sections.map((section) => (
        <details
          key={section.view}
          className="dash-section"
          open={OPEN_SECTIONS.has(section.view)}
          data-testid={`section-${section.view}`}
        >
          <summary>
            <h2>
              {section.title} <span className="muted">({section.rows.length})</span>
            </h2>
          </summary>
          {section.rows.length === 0 ? (
            <p className="empty">Nothing here.</p>
          ) : (
            <ul className="dash-rows">
              {section.rows.map((row) => (
                <RowLine key={`${row.view}:${row.key}`} row={row} rungs={rungs} />
              ))}
            </ul>
          )}
        </details>
      ))}
      <section className="dash-section" data-testid="section-projects">
        <h2>Projects</h2>
        {shown.projects.length === 0 ? (
          <p className="empty" data-testid="projects-empty">
            No projects in the reading.
          </p>
        ) : (
          <ul className="dash-projects" data-testid="project-list">
            {shown.projects.map((project) => (
              <ProjectItem key={project.name} project={project} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

/** The dispatcher's state, memory, pause and agent limit. */
const FleetHeader = ({
  reading,
  dispatcher,
  memory,
}: {
  readonly reading: Published;
  readonly dispatcher: DispatcherLine;
  readonly memory: { readonly free: number; readonly agents: number } | null;
}) => {
  const pause = useAtomSet(UiRpc.mutation("PolicyPause"), { mode: "promiseExit" });
  const resume = useAtomSet(UiRpc.mutation("PolicyResume"), { mode: "promiseExit" });
  const setSlots = useAtomSet(UiRpc.mutation("PolicySlots"), { mode: "promiseExit" });
  const [sent, setSent] = useState<{ readonly policy: Policy; readonly at: string | null }>();
  const [problem, setProblem] = useState<string | null>(null);
  // A reply shows at once; the next reading replaces it.
  const policy =
    sent !== undefined && sent.at === reading.observedAt ? sent.policy : reading.policy;
  const send = async (exit: Promise<Exit.Exit<Policy, { readonly message: string }>>) => {
    setProblem(null);
    const done = await exit;
    if (Exit.isSuccess(done)) setSent({ policy: done.value, at: reading.observedAt });
    else setProblem(reasonOf(done.cause));
  };
  return (
    <header className="dash-header" data-testid="fleet-header">
      <h1>Foreman</h1>
      <span className={`chip state-${dispatcher.state}`} data-testid="dispatcher-state">
        {dispatcherText(dispatcher)}
      </span>
      {memory === null ? null : (
        <span className="muted" data-testid="memory">
          {bytesLabel(memory.free)} free · agents {bytesLabel(memory.agents)}
        </span>
      )}
      <button
        type="button"
        data-testid={policy.paused ? "fleet-resume" : "fleet-pause"}
        onClick={() =>
          void send(
            policy.paused
              ? resume({ payload: { project: Option.none() } })
              : pause({ payload: { project: Option.none() } }),
          )
        }
      >
        {policy.paused ? "Resume" : "Pause"}
      </button>
      <AgentLimit
        slots={policy.slots}
        onSend={(count) => void send(setSlots({ payload: { count } }))}
        onProblem={setProblem}
      />
      <Link className="dash-link" to="/metrics" data-testid="metrics-link">
        Metrics
      </Link>
      {reading.policyError === null ? null : (
        <p className="problem" role="alert">
          Policy file: {reading.policyError}
        </p>
      )}
      {problem === null ? null : (
        <p className="problem" role="alert" data-testid="fleet-problem">
          {problem}
        </p>
      )}
    </header>
  );
};

/** How many agents may work at once, and the form that sets it. */
const AgentLimit = ({
  slots,
  onSend,
  onProblem,
}: {
  readonly slots: number;
  readonly onSend: (count: number) => void;
  readonly onProblem: (problem: string) => void;
}) => {
  const [text, setText] = useState(String(slots));
  useEffect(() => setText(String(slots)), [slots]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const count = Number(text);
    if (Number.isInteger(count) && count > 0) onSend(count);
    else onProblem("The agent limit is a whole number above 0.");
  };
  return (
    <form className="slots" onSubmit={submit}>
      <label>
        agents
        <input
          type="number"
          min={1}
          inputMode="numeric"
          value={text}
          onChange={(event) => setText(event.target.value)}
          data-testid="fleet-slots"
        />
      </label>
      <button type="submit" data-testid="fleet-slots-set" disabled={text === String(slots)}>
        Set
      </button>
    </form>
  );
};

/** One row: where it is, what it is, its links, and its actions. */
const RowLine = ({
  row,
  rungs,
}: {
  readonly row: PublishedRow;
  readonly rungs: ReadonlyArray<string>;
}) => (
  <li className="dash-row" data-testid={`row-${row.view}-${row.key}`}>
    <div className="dash-row-text">
      {row.project === null ? null : (
        <Link className="chip" to="/p/$name" params={{ name: row.project }}>
          {row.project}
        </Link>
      )}
      <span className="dash-label">{row.label}</span>
      {row.detail === null ? null : <span className="muted dash-detail">{row.detail}</span>}
      {row.url === null ? null : (
        <a href={row.url} target="_blank" rel="noreferrer">
          task
        </a>
      )}
      {row.pr === null ? null : (
        <a href={row.pr.url} target="_blank" rel="noreferrer">
          PR #{row.pr.number}
          {row.pr.checks === null ? "" : ` · ${row.pr.checks}`}
        </a>
      )}
    </div>
    <RowActions row={row} rungs={rungs} />
  </li>
);

/**
 * The actions a row lists. A key-only action runs on a tap, except that
 * `ASKS_FIRST` ones show one button that sends; `complete`, `kill` and
 * `intervene` open a form for what they take first.
 */
const RowActions = ({
  row,
  rungs,
}: {
  readonly row: PublishedRow;
  readonly rungs: ReadonlyArray<string>;
}) => {
  const run = useAtomSet(UiRpc.mutation("TaskAction"), { mode: "promiseExit" });
  const [form, setForm] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const actions = row.actions.flatMap((name) => {
    const action = actionNamed(name);
    return action === undefined ? [] : [action];
  });
  if (actions.length === 0) return null;

  const send = async (action: RowAction) => {
    setBusy(true);
    setNote(null);
    const exit = await run({ payload: { id: row.key, action } });
    setBusy(false);
    if (Exit.isSuccess(exit)) {
      setForm(null);
      setNote({ text: `${commandName(action._tag)}: sent`, failed: false });
    } else setNote({ text: reasonOf(exit.cause), failed: true });
  };

  return (
    <div className="dash-actions">
      <div className="dash-buttons">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            disabled={busy}
            aria-pressed={form === action}
            title={ACTION_HELP[action]}
            data-testid={`action-${row.key}-${commandName(action)}`}
            onClick={() =>
              isKeyOnly(action) && !ASKS_FIRST.has(action)
                ? void send({ _tag: action })
                : setForm(form === action ? null : action)
            }
          >
            {commandName(action)}
          </button>
        ))}
      </div>
      {/* The hover hint does not reach a touch screen, so the panel says it too. */}
      {form === null ? null : <p className="muted">{ACTION_HELP[form]}</p>}
      {form === null ? null : isKeyOnly(form) ? (
        <div className="action-form" data-testid={`action-form-${form}`}>
          <button
            type="button"
            disabled={busy}
            onClick={() => void send({ _tag: form })}
            data-testid="action-send"
          >
            {commandName(form)} {row.key}
          </button>
        </div>
      ) : (
        <ActionForm
          action={form}
          rungs={rungs}
          busy={busy}
          onSend={(action) => void send(action)}
        />
      )}
      {note === null ? null : (
        <p
          className={note.failed ? "problem" : "muted"}
          role={note.failed ? "alert" : "status"}
          data-testid={`action-note-${row.key}`}
        >
          {note.text}
        </p>
      )}
    </div>
  );
};

/** The inputs `complete`, `kill` and `intervene` take, and their send button. */
const ActionForm = ({
  action,
  rungs,
  busy,
  onSend,
}: {
  readonly action: "complete" | "kill" | "intervene";
  readonly rungs: ReadonlyArray<string>;
  readonly busy: boolean;
  readonly onSend: (action: RowAction) => void;
}) => {
  const [reason, setReason] = useState("");
  const [how, setHow] = useState<Intervention>("continue");
  const [rung, setRung] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const optional = (text: string) =>
      text.trim() === "" ? Option.none() : Option.some(text.trim());
    switch (action) {
      case "complete":
        return onSend({ _tag: "complete", reason: reason.trim() });
      case "kill":
        return onSend({ _tag: "kill", reason: optional(reason) });
      case "intervene":
        return onSend({
          _tag: "intervene",
          how,
          rung: how === "review" ? Option.none() : optional(rung),
        });
    }
  };
  return (
    <form className="action-form" onSubmit={submit} data-testid={`action-form-${action}`}>
      {action === "intervene" ? (
        <>
          <select value={how} onChange={(event) => setHow(event.target.value as Intervention)}>
            {INTERVENTIONS.map((one) => (
              <option key={one} value={one}>
                {one}
              </option>
            ))}
          </select>
          {how === "review" ? null : (
            <select
              value={rung}
              onChange={(event) => setRung(event.target.value)}
              aria-label="rung"
            >
              <option value="">same rung</option>
              {rungs.map((one) => (
                <option key={one} value={one}>
                  {one}
                </option>
              ))}
            </select>
          )}
        </>
      ) : (
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={action === "complete" ? "reason for the task log" : "reason (optional)"}
          required={action === "complete"}
          aria-label="reason"
          data-testid="action-reason"
        />
      )}
      <button type="submit" disabled={busy} data-testid="action-send">
        {action}
      </button>
    </form>
  );
};

/** One project: its board counts, pause, problems, and its pages. */
const ProjectItem = ({ project }: { readonly project: ProjectLine }) => {
  const counts = Object.entries(project.counts).filter(([, count]) => count > 0);
  return (
    <li className="dash-project" data-testid={`project-${project.name}`}>
      <Link className="dash-project-name" to="/p/$name" params={{ name: project.name }}>
        {project.name}
      </Link>
      {project.paused ? <span className="chip state-paused">paused</span> : null}
      <span className="muted">
        {counts.length === 0
          ? "nothing placed"
          : counts.map(([column, count]) => `${count} ${column}`).join(" · ")}
      </span>
      <Link to="/p/$name/graph" params={{ name: project.name }}>
        graph
      </Link>
      {project.problems.map((problem) => (
        <span key={problem} className="problem">
          {problem}
        </span>
      ))}
    </li>
  );
};

const isKeyOnly = (action: Action): action is (typeof KEY_ONLY_ACTIONS)[number] =>
  (KEY_ONLY_ACTIONS as ReadonlyArray<Action>).includes(action);

const dispatcherText = (line: DispatcherLine): string => {
  const age = line.age === null ? "" : ` · ${ageLabel(line.age)}`;
  switch (line.state) {
    case "none":
      return `no dispatcher${age}`;
    case "starting":
      return "no reading yet";
    case "failed":
      return `failed: ${line.detail}${age}`;
    default:
      return `${line.state}${age}`;
  }
};

const ageLabel = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
};

/** The current time, read again every `every` milliseconds, so ages count up. */
const useNow = (every: number): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
};
