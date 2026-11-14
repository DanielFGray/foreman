/**
 * What the dashboard at `/` shows, from one reading: the dispatcher's state,
 * the rows in the order the operator acts on them, and one line per project
 * (docs/web-ui.md, "The dashboard"). Pure, so its test is plain assertions.
 */
import { BOARD_COLUMNS, type BoardColumn } from "foreman/board-columns";
import type { Published, PublishedRow } from "foreman/published-schema";

/** A reading older than this is stale: the dispatcher stopped writing. */
export const STALE_MS = 120_000;

/** The dashboard's sections, in the order it shows them. */
export const SECTIONS = [
  { view: "attention", title: "Needs you" },
  { view: "working", title: "Working" },
  { view: "review", title: "Review" },
  { view: "landed", title: "Landed" },
  { view: "quota", title: "Quota" },
] as const;

export type SectionView = (typeof SECTIONS)[number]["view"];

export interface Section {
  readonly view: SectionView;
  readonly title: string;
  readonly rows: ReadonlyArray<PublishedRow>;
}

export interface ProjectLine {
  readonly name: string;
  /** How many of the project's placed tasks stand in each board column. */
  readonly counts: Readonly<Record<BoardColumn, number>>;
  readonly paused: boolean;
  /** Why the tracker did not answer, or why the pipeline cannot run. */
  readonly problems: ReadonlyArray<string>;
}

/**
 * What the dispatcher is doing as the header shows it. `stale` is a running
 * dispatcher whose last reading is older than `STALE_MS`; `none` is a reading
 * no dispatcher made. `starting` is a dispatcher whose first reading has not
 * completed.
 */
export type DispatcherLine =
  | {
      readonly state: "running" | "paused" | "idle" | "stale" | "none" | "starting";
      readonly age: number | null;
    }
  | { readonly state: "failed"; readonly age: number | null; readonly detail: string };

export interface Dashboard {
  readonly dispatcher: DispatcherLine;
  /** Free memory and what the live agents hold, in bytes; null when unread. */
  readonly memory: { readonly free: number; readonly agents: number } | null;
  readonly sections: ReadonlyArray<Section>;
  readonly projects: ReadonlyArray<ProjectLine>;
}

/** The dashboard for `reading` at the instant `now` (milliseconds). */
export const dashboardOf = (reading: Published, now: number): Dashboard => ({
  dispatcher: dispatcherLineOf(reading, now),
  memory:
    reading.availableMemory === null
      ? null
      : {
          free: reading.availableMemory,
          agents: Object.values(reading.workerMemory).reduce((sum, bytes) => sum + bytes, 0),
        },
  sections: SECTIONS.map(({ view, title }) => ({
    view,
    title,
    rows: reading.rows.filter((row) => row.view === view),
  })),
  projects: reading.projects.map((project) => ({
    name: project.name,
    counts: countsOf(reading.placements.filter((placed) => placed.project === project.name)),
    paused: reading.policy.projects[project.name]?.paused === true,
    problems: [
      ...(project.unreachable === null ? [] : [project.unreachable]),
      ...reading.stopped
        .filter((stopped) => stopped.project === project.name)
        .flatMap((stopped) => stopped.problems),
    ],
  })),
});

/** Bytes as a short label: "7.8G", "700M", "12K". */
export const bytesLabel = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, "")}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
};

const dispatcherLineOf = (reading: Published, now: number): DispatcherLine => {
  const age = reading.observedAt === null ? null : now - Date.parse(reading.observedAt);
  const dispatcher = reading.dispatcher;
  if (dispatcher === null) return { state: "none", age };
  if (dispatcher.state === "failed") return { state: "failed", age, detail: dispatcher.detail };
  if (age === null) return { state: "starting", age };
  if (age >= STALE_MS) return { state: "stale", age };
  return { state: dispatcher.state, age };
};

const countsOf = (
  placements: ReadonlyArray<{ readonly column: BoardColumn }>,
): Record<BoardColumn, number> => {
  const counts = Object.fromEntries(BOARD_COLUMNS.map((column) => [column, 0])) as Record<
    BoardColumn,
    number
  >;
  for (const { column } of placements) counts[column] += 1;
  return counts;
};
