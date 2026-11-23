/**
 * The metrics page at `/metrics`: what the closed agent runs of a window cost,
 * which models ran them, how long they took and how each rung ended. The
 * window and who launched the runs are the route's search params; each card's
 * measure and view are its own.
 */
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { Cause } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import {
  endingsByRung,
  FAILED_ENDINGS,
  LAUNCHERS,
  launchedBy,
  runningTotal,
  runTimes,
  shareByModel,
  TIME_BINS,
  type Coverage,
  type Launcher,
  type MetricsRun,
  type ShareMeasure,
  type SpendMeasure,
  type TimeMeasure,
} from "foreman/metrics";
import { useState } from "react";
import { Card, DataTable, Histogram, LineChart, RankedBars, type BarRow } from "./charts.tsx";
import { metricsAtom } from "./rpc.ts";

/** The windows the page offers, in days; null is all time. */
export const WINDOWS = [7, 30, 90, null] as const;
export type MetricsWindow = (typeof WINDOWS)[number];

/** The page's filters. */
export interface MetricsSearch {
  readonly window: MetricsWindow;
  readonly launcher: Launcher;
}

/** The filters as the route's search params: flat strings, a default left out. */
export interface MetricsQuery {
  readonly window?: string;
  readonly launcher?: string;
}

const DEFAULT_SEARCH: MetricsSearch = { window: 30, launcher: "all" };

const windowKey = (window: MetricsWindow): string => String(window ?? "all");

/** Keeps the page's own keys of a parsed query (the route's `validateSearch`). */
export const metricsQueryOf = (query: Record<string, unknown>): MetricsQuery =>
  Object.fromEntries(
    (["window", "launcher"] as const).flatMap((key) =>
      typeof query[key] === "string" ? [[key, query[key]]] : [],
    ),
  );

/** Reads the filters from the search params; a missing or unknown value takes the default. */
export const metricsSearchOf = (query: MetricsQuery): MetricsSearch => {
  // All time is the null window, so a found window can be null: a destructuring
  // default applies only when nothing was found, where `??` would also replace null.
  const [window = DEFAULT_SEARCH.window] = WINDOWS.filter(
    (each) => windowKey(each) === query.window,
  );
  return {
    window,
    launcher: LAUNCHERS.find((each) => each === query.launcher) ?? DEFAULT_SEARCH.launcher,
  };
};

/** The search params for the filters. */
export const queryOfMetrics = (search: MetricsSearch): MetricsQuery => ({
  ...(search.window === DEFAULT_SEARCH.window ? {} : { window: windowKey(search.window) }),
  ...(search.launcher === DEFAULT_SEARCH.launcher ? {} : { launcher: search.launcher }),
});

export const MetricsPage = ({
  search,
  setSearch,
}: {
  readonly search: MetricsSearch;
  readonly setSearch: (search: MetricsSearch) => void;
}) => {
  const result = useAtomValue(metricsAtom(windowKey(search.window)));
  return (
    <div className="app app-wide" data-testid="metrics-page">
      <Link className="back" to="/">
        ← dashboard
      </Link>
      <header className="header">
        <h1>Metrics</h1>
        <span className="muted">closed agent runs</span>
      </header>
      <Filters search={search} setSearch={setSearch} />
      {AsyncResult.isSuccess(result) ? (
        <Cards runs={launchedBy(result.value, search.launcher)} />
      ) : AsyncResult.isFailure(result) ? (
        <p className="problem" role="alert">
          Could not read the runs: {Cause.pretty(result.cause)}
        </p>
      ) : (
        <p className="muted">Reading the runs…</p>
      )}
    </div>
  );
};

const Filters = ({
  search,
  setSearch,
}: {
  readonly search: MetricsSearch;
  readonly setSearch: (search: MetricsSearch) => void;
}) => (
  <div className="viz-filters">
    <Choice
      label="Window"
      options={WINDOWS.map((each) => ({ id: each, text: each === null ? "All" : `${each}d` }))}
      value={search.window}
      onChange={(window) => setSearch({ ...search, window })}
      testid="window"
    />
    <Choice
      label="Launched by"
      options={LAUNCHERS.map((each) => ({ id: each, text: each }))}
      value={search.launcher}
      onChange={(launcher) => setSearch({ ...search, launcher })}
      testid="launcher"
    />
  </div>
);

/** A row of pressed-or-not buttons that picks one value. */
const Choice = <T,>({
  label,
  options,
  value,
  onChange,
  testid,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly id: T; readonly text: string }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly testid: string;
}) => (
  <div className="viz-toggle" role="group" aria-label={label}>
    <span className="muted viz-toggle-label">{label}</span>
    {options.map((option) => (
      <button
        key={option.text}
        type="button"
        aria-pressed={option.id === value}
        onClick={() => onChange(option.id)}
        data-testid={`${testid}-${option.text}`}
      >
        {option.text}
      </button>
    ))}
  </div>
);

const Cards = ({ runs }: { readonly runs: ReadonlyArray<MetricsRun> }) => (
  <>
    <Totals runs={runs} />
    <div className="viz-grid-cards">
      <SpendCard runs={runs} />
      <ModelCard runs={runs} />
      <TimeCard runs={runs} />
      <EndingsCard runs={runs} />
    </div>
  </>
);

type View = "chart" | "table";
const VIEWS: ReadonlyArray<{ readonly id: View; readonly label: string }> = [
  { id: "chart", label: "Chart" },
  { id: "table", label: "Table" },
];

/** The headline numbers: each with how many runs it could read. */
const Totals = ({ runs }: { readonly runs: ReadonlyArray<MetricsRun> }) => {
  const tokens = runningTotal(runs, "tokens");
  const cost = runningTotal(runs, "costUsd");
  const times = runTimes(runs, "wallMinutes");
  const tiles = [
    { label: "Runs", value: String(runs.length), note: null },
    {
      label: "Tokens",
      value: tokensLabel(tokens.points.at(-1)?.total ?? 0),
      note: coverageLabel(tokens),
    },
    {
      label: "Billed cost",
      value: dollarsLabel(cost.points.at(-1)?.total ?? 0),
      note: coverageLabel(cost),
    },
    {
      label: "Median run",
      value: times.p50 === undefined ? "–" : minutesLabel(times.p50),
      note: coverageLabel(times),
    },
  ];
  return (
    <div className="viz-tiles" data-testid="metrics-totals">
      {tiles.map((tile) => (
        <div key={tile.label} className="viz-tile">
          <span className="muted">{tile.label}</span>
          <strong>{tile.value}</strong>
          {tile.note === null ? null : <span className="muted viz-note">{tile.note}</span>}
        </div>
      ))}
    </div>
  );
};

const SPEND: ReadonlyArray<{ readonly id: SpendMeasure; readonly text: string }> = [
  { id: "tokens", text: "Tokens" },
  { id: "costUsd", text: "Billed cost" },
];

const SpendCard = ({ runs }: { readonly runs: ReadonlyArray<MetricsRun> }) => {
  const [view, setView] = useState<View>("chart");
  const [measure, setMeasure] = useState<SpendMeasure>("tokens");
  const total = runningTotal(runs, measure);
  const format = measure === "tokens" ? tokensLabel : dollarsLabel;
  return (
    <Card
      id="spend"
      title="Spend over time"
      summary={coverageLabel(total)}
      views={VIEWS}
      view={view}
      onView={setView}
    >
      <Choice
        label="Measure"
        options={SPEND}
        value={measure}
        onChange={setMeasure}
        testid="spend-measure"
      />
      {view === "chart" ? (
        <LineChart points={total.points} formatValue={format} formatTime={dayLabel} />
      ) : (
        <DataTable
          columns={["Day", "Runs", "Spent", "Total"]}
          rows={perDay(total.points).map((day) => [
            dayLabel(day.at),
            String(day.runs),
            format(day.spent),
            format(day.total),
          ])}
        />
      )}
    </Card>
  );
};

const SHARE: ReadonlyArray<{ readonly id: ShareMeasure; readonly text: string }> = [
  { id: "runs", text: "Runs" },
  { id: "tokens", text: "Tokens" },
  { id: "costUsd", text: "Billed cost" },
];

/** The chart shows this many models; the rest fold into one bar. The table lists all. */
const SHOWN_MODELS = 10;

const ModelCard = ({ runs }: { readonly runs: ReadonlyArray<MetricsRun> }) => {
  const [view, setView] = useState<View>("chart");
  const [measure, setMeasure] = useState<ShareMeasure>("runs");
  const share = shareByModel(runs, measure);
  const format = measure === "runs" ? String : measure === "tokens" ? tokensLabel : dollarsLabel;
  const sum = share.rows.reduce((total, row) => total + row.value, 0);
  const percent = (value: number) => `${sum === 0 ? 0 : Math.round((value / sum) * 100)}%`;
  const rest = share.rows.slice(SHOWN_MODELS);
  const shown =
    rest.length <= 1
      ? share.rows
      : [
          ...share.rows.slice(0, SHOWN_MODELS),
          {
            key: `${rest.length} other models`,
            value: rest.reduce((total, row) => total + row.value, 0),
          },
        ];
  const bars: ReadonlyArray<BarRow> = shown.map((row) => ({
    ...row,
    lines: [
      {
        value: format(row.value),
        name: SHARE.find((each) => each.id === measure)?.text.toLowerCase() ?? "",
      },
      { value: percent(row.value), name: "of the total" },
    ],
  }));
  return (
    <Card
      id="models"
      title="Share by model"
      summary={coverageLabel(share)}
      views={VIEWS}
      view={view}
      onView={setView}
    >
      <Choice
        label="Measure"
        options={SHARE}
        value={measure}
        onChange={setMeasure}
        testid="model-measure"
      />
      {view === "chart" ? (
        <RankedBars rows={bars} formatValue={format} />
      ) : (
        <DataTable
          columns={["Model", "Amount", "Share"]}
          rows={share.rows.map((row) => [row.key, format(row.value), percent(row.value)])}
        />
      )}
    </Card>
  );
};

const TIMES: ReadonlyArray<{ readonly id: TimeMeasure; readonly text: string }> = [
  { id: "wallMinutes", text: "Start to close" },
  { id: "activeMinutes", text: "Active" },
];

const TimeCard = ({ runs }: { readonly runs: ReadonlyArray<MetricsRun> }) => {
  const [view, setView] = useState<View>("chart");
  const [measure, setMeasure] = useState<TimeMeasure>("wallMinutes");
  const times = runTimes(runs, measure);
  const bins = times.bins.map((bin) => ({
    label: minutesLabel(bin.from),
    title:
      bin.to === null
        ? `${minutesLabel(bin.from)} or more`
        : `${minutesLabel(bin.from)} to ${minutesLabel(bin.to)}`,
    count: bin.count,
  }));
  const marks = [
    { value: times.p50, name: "p50" },
    { value: times.p90, name: "p90" },
  ].flatMap(({ value, name }) =>
    value === undefined
      ? []
      : [{ at: binPosition(value), label: `${name} ${minutesLabel(value)}` }],
  );
  return (
    <Card
      id="times"
      title="Run time"
      summary={coverageLabel(times)}
      views={VIEWS}
      view={view}
      onView={setView}
    >
      <Choice
        label="Measure"
        options={TIMES}
        value={measure}
        onChange={setMeasure}
        testid="time-measure"
      />
      {view === "chart" ? (
        <Histogram bins={bins} marks={marks} />
      ) : (
        <>
          <DataTable
            columns={["Run time", "Runs"]}
            rows={bins.map((bin) => [bin.title, String(bin.count)])}
          />
          <p className="muted viz-note">{marks.map((mark) => mark.label).join(" · ")}</p>
        </>
      )}
    </Card>
  );
};

const EndingsCard = ({ runs }: { readonly runs: ReadonlyArray<MetricsRun> }) => {
  const [view, setView] = useState<View>("chart");
  const endings = endingsByRung(runs);
  const failedShare = (failed: number, ended: number) => `${Math.round((failed / ended) * 100)}%`;
  const bars: ReadonlyArray<BarRow> = endings.rows.map((row) => ({
    key: row.key,
    value: row.ended,
    failed: row.failed,
    lines: [
      { value: String(row.ended), name: "ended" },
      { value: `${row.failed} (${failedShare(row.failed, row.ended)})`, name: "failed" },
    ],
  }));
  return (
    <Card
      id="endings"
      title="Endings per rung"
      summary={`${coverageLabel(endings)} that foreman settled`}
      views={VIEWS}
      view={view}
      onView={setView}
    >
      <p className="viz-legend">
        <span className="viz-swatch" /> finished
        <span className="viz-swatch viz-swatch-failed" /> failed: {FAILED_ENDINGS.join(", ")}
      </p>
      {endings.rows.length === 0 ? (
        <p className="muted">
          No run in this window has a rung and an ending: a run launched by hand has neither.
        </p>
      ) : view === "chart" ? (
        <RankedBars rows={bars} formatValue={String} />
      ) : (
        <DataTable
          columns={["Rung", "Ended", "Failed", "Failed share"]}
          rows={endings.rows.map((row) => [
            row.key,
            String(row.ended),
            String(row.failed),
            failedShare(row.failed, row.ended),
          ])}
        />
      )}
    </Card>
  );
};

/**
 * Where `minutes` falls across the histogram, from 0 at its left edge to 1 at
 * its right: the bin it is in, then its place inside that bin. The last bin
 * has no upper edge, so a value in it sits at the bin's middle.
 */
const binPosition = (minutes: number): number => {
  const index = TIME_BINS.findLastIndex((from) => minutes >= from);
  const from = TIME_BINS[index] ?? 0;
  const to = TIME_BINS[index + 1];
  const inside = to === undefined ? 0.5 : (minutes - from) / (to - from);
  return (index + inside) / TIME_BINS.length;
};

/** A running total's points grouped by local day: each day's spend and the total at its end. */
const perDay = (points: ReadonlyArray<{ readonly at: number; readonly total: number }>) => {
  const days: Array<{ at: number; runs: number; spent: number; total: number }> = [];
  let before = 0;
  for (const point of points) {
    const at = new Date(point.at).setHours(0, 0, 0, 0);
    const last = days.at(-1);
    if (last?.at === at) {
      last.runs += 1;
      last.spent += point.total - before;
      last.total = point.total;
    } else {
      days.push({ at, runs: 1, spent: point.total - before, total: point.total });
    }
    before = point.total;
  }
  return days.reverse();
};

const coverageLabel = ({ covered, of }: Coverage): string => `${covered} of ${of} runs`;

const dayLabel = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const minutesLabel = (minutes: number): string =>
  minutes < 1
    ? `${Math.round(minutes * 60)}s`
    : minutes < 60
      ? `${Math.round(minutes)}m`
      : `${Math.round((minutes / 60) * 10) / 10}h`;

const dollarsLabel = (dollars: number): string =>
  dollars < 10 ? `$${dollars.toFixed(2)}` : `$${Math.round(dollars).toLocaleString()}`;

const tokensLabel = (tokens: number): string =>
  tokens >= 1e9
    ? `${(tokens / 1e9).toFixed(1)}B`
    : tokens >= 1e6
      ? `${(tokens / 1e6).toFixed(1)}M`
      : tokens >= 1e3
        ? `${Math.round(tokens / 1e3)}k`
        : String(Math.round(tokens));
