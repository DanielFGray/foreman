import { Result, Schema as S } from "effect";

export interface Run {
  readonly name: string;
  readonly start: number;
  readonly end: number | undefined;
  readonly attributes: Readonly<Record<string, string>>;
  readonly outcome: string | undefined;
}

export interface RunMetrics {
  readonly runs: number;
  readonly medianDuration: number | undefined;
  readonly p90Duration: number | undefined;
  readonly reviewRejectionRate: number;
  readonly escalationRate: number;
  readonly landRate: number;
  readonly verificationBreakRate: number;
}

export interface RunTable {
  readonly key: string;
  readonly metrics: RunMetrics;
}

interface OtlpValue {
  readonly stringValue?: string;
  readonly intValue?: string;
  readonly doubleValue?: number;
  readonly boolValue?: boolean;
}

interface OtlpSpan {
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano?: string;
  readonly attributes?: ReadonlyArray<{ readonly key: string; readonly value: OtlpValue }>;
}

/** Parses the collector's newline-delimited OTLP file-exporter payloads. */
export const runsFromOtlp = (payloads: ReadonlyArray<string>): ReadonlyArray<Run> =>
  payloads.flatMap((payload) =>
    payload
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) =>
        Result.match(S.decodeUnknownResult(S.fromJsonString(S.Unknown))(line), {
          onFailure: () => [],
          onSuccess: (decoded) => spansOf(decoded as OtlpExport),
        }),
      ),
  );

/** Four independent views prevent sparse model-by-project cells from reading as signal. */
export const tablesFor = (runs: ReadonlyArray<Run>) => ({
  rung: tableFor(runs, (run) => run.attributes.rung),
  project: tableFor(runs, (run) => run.attributes.project),
  label: tableFor(runs, (run) => (run.attributes.labels ?? "").split(",").filter(Boolean)),
  task: tableFor(runs, (run) => run.attributes.task),
});

const spansOf = (exported: OtlpExport): ReadonlyArray<Run> =>
  exported.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans.map(runOf)),
  );

const runOf = (span: OtlpSpan): Run => {
  const attributes = Object.fromEntries(
    (span.attributes ?? []).flatMap(({ key, value }) => {
      const scalar =
        value.stringValue ??
        value.intValue ??
        value.doubleValue?.toString() ??
        value.boolValue?.toString();
      return scalar === undefined ? [] : [[key, scalar]];
    }),
  );
  return {
    name: span.name,
    start: Number(span.startTimeUnixNano) / 1_000_000,
    end: span.endTimeUnixNano === undefined ? undefined : Number(span.endTimeUnixNano) / 1_000_000,
    attributes,
    outcome: attributes.outcome,
  };
};

const tableFor = (
  runs: ReadonlyArray<Run>,
  keys: (run: Run) => string | undefined | ReadonlyArray<string>,
): ReadonlyArray<RunTable> => {
  const grouped = new Map<string, Array<Run>>();
  for (const run of runs) {
    const values = keys(run);
    for (const key of values === undefined ? [] : typeof values === "string" ? [values] : values) {
      grouped.set(key, [...(grouped.get(key) ?? []), run]);
    }
  }
  return [...grouped.entries()].map(([key, groupedRuns]) => ({
    key,
    metrics: metricsFor(groupedRuns),
  }));
};

const metricsFor = (runs: ReadonlyArray<Run>): RunMetrics => {
  const completed = runs.filter(
    (run): run is Run & { readonly end: number } => run.end !== undefined,
  );
  const durations = completed.map((run) => run.end - run.start).sort((left, right) => left - right);
  const rate = (predicate: (run: Run) => boolean) =>
    completed.length === 0 ? 0 : completed.filter(predicate).length / completed.length;
  return {
    runs: runs.length,
    medianDuration: percentile(durations, 0.5),
    p90Duration: percentile(durations, 0.9),
    reviewRejectionRate: rate((run) => run.outcome === "ReviewReturned"),
    escalationRate: rate((run) => run.attributes.escalation === "true"),
    landRate: rate((run) => run.outcome === "Landed"),
    verificationBreakRate: rate((run) => run.attributes.verification === "broken"),
  };
};

const percentile = (values: ReadonlyArray<number>, at: number): number | undefined => {
  if (values.length === 0) return undefined;
  return values[Math.ceil(values.length * at) - 1];
};

interface OtlpExport {
  readonly resourceSpans: ReadonlyArray<{
    readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<OtlpSpan> }>;
  }>;
}
