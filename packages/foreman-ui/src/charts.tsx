/**
 * The metrics page's chart pieces, drawn by hand in SVG and HTML: a card that
 * switches between its views, a running-total line, ranked bars and a
 * histogram. Colors are the `--viz-*` tokens in styles.css; text never wears
 * them. Every value a hover shows is also in the card's table view.
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

/** One line of a tooltip: the value leads, the name follows. */
export interface TipLine {
  readonly value: string;
  readonly name: string;
}

interface Tip {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly lines: ReadonlyArray<TipLine>;
}

/**
 * A titled card whose views show the same data: one view at a time, chosen by
 * the toggle in its header. A table is always one of them.
 */
export const Card = <V extends string>({
  id,
  title,
  summary,
  views,
  view,
  onView,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly views: ReadonlyArray<{ readonly id: V; readonly label: string }>;
  readonly view: V;
  readonly onView: (view: V) => void;
  readonly children: ReactNode;
}) => (
  <section className="viz-card" data-testid={`card-${id}`} aria-labelledby={`${id}-title`}>
    <header className="viz-card-head">
      <h2 id={`${id}-title`}>{title}</h2>
      <span className="muted viz-summary">{summary}</span>
      <div className="viz-toggle" role="group" aria-label={`${title} view`}>
        {views.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={option.id === view}
            onClick={() => onView(option.id)}
            data-testid={`view-${id}-${option.id}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </header>
    {children}
  </section>
);

/** A plain table: the view every chart's values stay reachable in. */
export const DataTable = ({
  columns,
  rows,
}: {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}) =>
  rows.length === 0 ? (
    <p className="muted">No runs in this window.</p>
  ) : (
    <div className="viz-table-wrap">
      <table className="viz-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (
                <td key={column}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

const HEIGHT = 180;
const PAD = { top: 12, right: 56, bottom: 22, left: 48 };

/**
 * A running total over time: a 2px line over a 10% wash, the last value
 * labeled at its end, and a crosshair that snaps to the nearest point.
 */
export const LineChart = ({
  points,
  formatValue,
  formatTime,
}: {
  readonly points: ReadonlyArray<{ readonly at: number; readonly total: number }>;
  readonly formatValue: (value: number) => string;
  readonly formatTime: (at: number) => string;
}) => {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return <p className="muted">No runs in this window report it.</p>;
  }
  const plotWidth = Math.max(1, width - PAD.left - PAD.right);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const span = Math.max(1, last.at - first.at);
  const top = niceCeiling(last.total);
  const x = (at: number) => PAD.left + ((at - first.at) / span) * plotWidth;
  const y = (value: number) => PAD.top + plotHeight - (value / top) * plotHeight;
  const line = points.map((point) => `${x(point.at)},${y(point.total)}`).join(" ");
  const area = `${x(first.at)},${y(0)} ${line} ${x(last.at)},${y(0)}`;
  const ticks = [0, top / 2, top];
  const shown = hover === null ? undefined : points[hover];

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const left = event.currentTarget.getBoundingClientRect().left;
    const at = first.at + ((event.clientX - left - PAD.left) / plotWidth) * span;
    setHover(nearestIndex(points, at));
  };

  return (
    <div className="viz-plot" ref={ref}>
      {width === 0 ? null : (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Rises to ${formatValue(last.total)} by ${formatTime(last.at)}`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                className="viz-grid"
                x1={PAD.left}
                x2={PAD.left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text
                className="viz-tick"
                x={PAD.left - 6}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {formatValue(tick)}
              </text>
            </g>
          ))}
          <text className="viz-tick" x={PAD.left} y={HEIGHT - 4}>
            {formatTime(first.at)}
          </text>
          <text className="viz-tick" x={PAD.left + plotWidth} y={HEIGHT - 4} textAnchor="end">
            {formatTime(last.at)}
          </text>
          <polygon className="viz-wash" points={area} />
          <polyline className="viz-line" points={line} />
          <circle className="viz-dot" cx={x(last.at)} cy={y(last.total)} r={4} />
          <text
            className="viz-end-label"
            x={x(last.at) + 8}
            y={y(last.total)}
            dominantBaseline="middle"
          >
            {formatValue(last.total)}
          </text>
          {shown === undefined ? null : (
            <g>
              <line
                className="viz-crosshair"
                x1={x(shown.at)}
                x2={x(shown.at)}
                y1={PAD.top}
                y2={PAD.top + plotHeight}
              />
              <circle className="viz-dot" cx={x(shown.at)} cy={y(shown.total)} r={4} />
            </g>
          )}
        </svg>
      )}
      {shown === undefined ? null : (
        <Tooltip
          tip={{
            x: x(shown.at),
            y: y(shown.total),
            title: formatTime(shown.at),
            lines: [{ value: formatValue(shown.total), name: "total so far" }],
          }}
          width={width}
        />
      )}
    </div>
  );
};

/** One bar of a ranked list; `failed` is the part of `value` drawn in the failure color. */
export interface BarRow {
  readonly key: string;
  readonly value: number;
  readonly failed?: number;
  readonly lines: ReadonlyArray<TipLine>;
}

/**
 * Ranked horizontal bars, largest first, on one baseline: the name, the bar and
 * its value per row. A row's hover or focus shows its tooltip.
 */
export const RankedBars = ({
  rows,
  formatValue,
}: {
  readonly rows: ReadonlyArray<BarRow>;
  readonly formatValue: (value: number) => string;
}) => {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const top = Math.max(1, ...rows.map((row) => row.value));
  if (rows.length === 0) return <p className="muted">No runs in this window.</p>;
  const show = (row: BarRow, element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    const frame = ref.current?.getBoundingClientRect();
    setTip({
      x: box.left - (frame?.left ?? 0) + box.width / 2,
      y: box.top - (frame?.top ?? 0),
      title: row.key,
      lines: row.lines,
    });
  };
  return (
    <div className="viz-plot" ref={ref} onPointerLeave={() => setTip(null)}>
      <ul className="viz-bars">
        {rows.map((row) => {
          const failed = row.failed ?? 0;
          return (
            <li
              key={row.key}
              tabIndex={0}
              onPointerEnter={(event) => show(row, event.currentTarget)}
              onPointerDown={(event) => show(row, event.currentTarget)}
              onFocus={(event) => show(row, event.currentTarget)}
              onBlur={() => setTip(null)}
            >
              <span className="viz-bar-name">{row.key}</span>
              <span className="viz-bar-track">
                <span
                  className="viz-bar"
                  style={{ width: `${((row.value - failed) / top) * 100}%` }}
                />
                {failed === 0 ? null : (
                  <span
                    className="viz-bar viz-bar-failed"
                    style={{ width: `${(failed / top) * 100}%` }}
                  />
                )}
              </span>
              <span className="viz-bar-value">{formatValue(row.value)}</span>
            </li>
          );
        })}
      </ul>
      {tip === null ? null : <Tooltip tip={tip} width={width} />}
    </div>
  );
};

/** Columns over ordered bins, with labeled hairlines at the median and the 90th percentile. */
export const Histogram = ({
  bins,
  marks,
}: {
  /** `label` names a bin under the axis; `title` heads its tooltip. */
  readonly bins: ReadonlyArray<{
    readonly label: string;
    readonly title: string;
    readonly count: number;
  }>;
  /** Where each mark falls, from 0 at the left edge to 1 at the right, in rising order. */
  readonly marks: ReadonlyArray<{ readonly at: number; readonly label: string }>;
}) => {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotWidth = Math.max(1, width - PAD.left - 12);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const top = niceCeiling(Math.max(1, ...bins.map((bin) => bin.count)));
  const slot = plotWidth / Math.max(1, bins.length);
  const bar = Math.min(24, slot - 2);
  const y = (value: number) => PAD.top + plotHeight - (value / top) * plotHeight;
  const shown = hover === null ? undefined : bins[hover];
  return (
    <div className="viz-plot" ref={ref}>
      {width === 0 ? null : (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label="Runs per run-time bin"
          onPointerLeave={() => setHover(null)}
        >
          {[0, top / 2, top].map((tick) => (
            <g key={tick}>
              <line
                className="viz-grid"
                x1={PAD.left}
                x2={PAD.left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text
                className="viz-tick"
                x={PAD.left - 6}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {Math.round(tick)}
              </text>
            </g>
          ))}
          {bins.map((bin, index) => {
            const left = PAD.left + index * slot + (slot - bar) / 2;
            return (
              <g key={bin.label}>
                {/* The hit target is the whole slot, not the painted column. */}
                <rect
                  x={PAD.left + index * slot}
                  y={PAD.top}
                  width={slot}
                  height={plotHeight}
                  fill="transparent"
                  tabIndex={0}
                  onPointerEnter={() => setHover(index)}
                  onPointerDown={() => setHover(index)}
                  onFocus={() => setHover(index)}
                  onBlur={() => setHover(null)}
                />
                {bin.count === 0 ? null : (
                  <path
                    className={hover === index ? "viz-column viz-hover" : "viz-column"}
                    d={columnPath(left, y(bin.count), bar, y(0))}
                    pointerEvents="none"
                  />
                )}
                {/* A bin's label names its lower edge, so it sits on the slot's left boundary. */}
                <text
                  className="viz-tick"
                  x={PAD.left + index * slot}
                  y={HEIGHT - 4}
                  textAnchor="middle"
                >
                  {bin.label}
                </text>
              </g>
            );
          })}
          {marks.map((mark, index) => {
            const at = PAD.left + mark.at * plotWidth;
            // Marks come in rising order: the first labels to its left and the
            // rest to their right, so two close marks never print over each other.
            const left = index === 0 && marks.length > 1;
            return (
              <g key={mark.label} pointerEvents="none">
                <line className="viz-rule" x1={at} x2={at} y1={PAD.top} y2={PAD.top + plotHeight} />
                <text
                  className="viz-tick viz-rule-label"
                  x={left ? at - 4 : at + 4}
                  y={PAD.top + 8}
                  textAnchor={left ? "end" : "start"}
                >
                  {mark.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {shown === undefined || hover === null ? null : (
        <Tooltip
          tip={{
            x: PAD.left + hover * slot + slot / 2,
            y: y(shown.count),
            title: shown.title,
            lines: [{ value: String(shown.count), name: shown.count === 1 ? "run" : "runs" }],
          }}
          width={width}
        />
      )}
    </div>
  );
};

/** A column rounded at its data end and square on the baseline. */
const columnPath = (left: number, top: number, width: number, base: number): string => {
  const radius = Math.min(4, width / 2, Math.max(0, base - top));
  return [
    `M${left},${base}`,
    `V${top + radius}`,
    `Q${left},${top} ${left + radius},${top}`,
    `H${left + width - radius}`,
    `Q${left + width},${top} ${left + width},${top + radius}`,
    `V${base}`,
    "Z",
  ].join(" ");
};

const Tooltip = ({ tip, width }: { readonly tip: Tip; readonly width: number }) => (
  <div
    className="viz-tooltip"
    role="status"
    style={{
      left: Math.min(Math.max(tip.x, 70), Math.max(70, width - 70)),
      top: tip.y,
    }}
  >
    <div className="viz-tooltip-title">{tip.title}</div>
    {tip.lines.map((line) => (
      <div key={line.name} className="viz-tooltip-line">
        <strong>{line.value}</strong> <span className="muted">{line.name}</span>
      </div>
    ))}
  </div>
);

/** The index of the point closest in time to `at`. */
const nearestIndex = (points: ReadonlyArray<{ readonly at: number }>, at: number): number => {
  let best = 0;
  points.forEach((point, index) => {
    if (Math.abs(point.at - at) < Math.abs((points[best]?.at ?? 0) - at)) best = index;
  });
  return best;
};

/** A round number at or above `value`, for an axis top: 1, 2 or 5 times a power of ten. */
export const niceCeiling = (value: number): number => {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((each) => each * power >= value) ?? 10;
  return step * power;
};

/** The rendered width of an element, kept current as it resizes. */
const useWidth = <E extends HTMLElement>(): readonly [RefObject<E | null>, number] => {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
};
