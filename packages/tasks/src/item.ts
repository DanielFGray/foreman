/**
 * What a task is, the statuses it moves through, and the machine that says
 * which moves are allowed.
 */
import { Schema as S } from "effect";
import type { Machine } from "./machine.ts";

export const STATUSES = [
  "proposed",
  "draft",
  "open",
  "in_progress",
  "blocked",
  "reviewing",
  "done",
  "canceled",
] as const;
export const Status = S.Literals(STATUSES);
export type Status = typeof Status.Type;

/**
 * The statuses a task is stored in. `blocked` is not one: it is derived, for an
 * epic, from its children, and no command sets it.
 */
export type TaskState = Exclude<Status, "blocked">;

export const ItemType = S.Literals(["task", "epic"]);
export type ItemType = typeof ItemType.Type;

export interface Item {
  readonly id: string;
  readonly project: string;
  readonly type: ItemType;
  readonly title: string;
  readonly description: string;
  readonly definitionOfDone: string | undefined;
  /** For an epic, derived from its children unless it was closed by hand. */
  readonly status: Status;
  /** 1 is high, 3 is low. */
  readonly priority: number;
  readonly parent: string | undefined;
  readonly labels: ReadonlyArray<string>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** The later of `updatedAt` and the newest log entry. */
  readonly lastActivityAt: Date;
}

export const TASK_EVENTS = [
  "propose",
  "draft",
  "open",
  "start",
  "review",
  "submit",
  "done",
  "cancel",
] as const;
export type TaskEvent = (typeof TASK_EVENTS)[number];

const STORED: ReadonlyArray<TaskState> = STATUSES.filter(
  (status): status is TaskState => status !== "blocked",
);

/**
 * A task's status, and the moves between statuses.
 *
 * - A proposal (nobody authorised it) and a draft (still being scoped) become
 *   open work, and open work can go back to either.
 * - Open or reviewed work starts, and only started work goes to review.
 * - A branch nobody read is submitted for review from wherever its task stands:
 *   queued, started, done or canceled. The commits exist, and whether they are
 *   worth landing is what a reviewer answers. A proposal or a draft has no
 *   authorised work to submit.
 * - Reviewed work can start again without a release when its pipeline sends
 *   it to another author.
 * - Started or reviewed work returns to `open`: a release, a rejection, a
 *   landing that conflicted.
 * - Reviewed work is done when it lands. Open or started work can be closed by
 *   hand, when the trunk already does what it asked. A proposal or a draft
 *   cannot be done: nobody agreed to do it, so it is canceled instead.
 * - Anything unfinished can be canceled, and done or canceled work reopens.
 */
export const TASK_MACHINE: Machine<TaskState, TaskEvent> = {
  id: "task",
  states: STORED,
  events: TASK_EVENTS,
  initial: ["open", "draft", "proposed"],
  on: {
    propose: { draft: "proposed", open: "proposed" },
    draft: { proposed: "draft", open: "draft" },
    open: {
      proposed: "open",
      draft: "open",
      in_progress: "open",
      reviewing: "open",
      done: "open",
      canceled: "open",
    },
    start: { open: "in_progress", reviewing: "in_progress" },
    review: { in_progress: "reviewing" },
    submit: {
      open: "reviewing",
      in_progress: "reviewing",
      done: "reviewing",
      canceled: "reviewing",
    },
    done: { open: "done", in_progress: "done", reviewing: "done" },
    cancel: {
      proposed: "canceled",
      draft: "canceled",
      open: "canceled",
      in_progress: "canceled",
      reviewing: "canceled",
    },
  },
};

/**
 * An epic's status, from the statuses of its children.
 *
 * Closed by hand (`done` or `canceled` stored) wins. With no children the epic
 * is a draft. Otherwise: every child resolved is done; every unresolved child
 * blocked is blocked; any child started or finished is in progress; every
 * unresolved child a draft or a proposal is a draft; else open.
 */
export const epicStatus = (stored: Status, children: ReadonlyArray<Status>): Status => {
  if (stored === "done" || stored === "canceled") return stored;
  if (children.length === 0) return "draft";
  const count = (...statuses: ReadonlyArray<Status>) =>
    children.filter((child) => statuses.includes(child)).length;
  const unresolved = children.length - count("done", "canceled");
  if (unresolved === 0) return "done";
  if (count("blocked") === unresolved) return "blocked";
  if (count("in_progress", "reviewing", "done") > 0) return "in_progress";
  if (count("draft", "proposed") === unresolved) return "draft";
  return "open";
};
