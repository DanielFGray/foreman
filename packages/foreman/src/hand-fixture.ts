import type { Terminal } from "./hc.ts";

/**
 * A foreman agent that exited, on a task a coordinator then took over by hand.
 * Foreman keeps finished terminals as the record of an agent that went away, so
 * this one stays in the roster beside the coordinator's live agent.
 */
export const finishedForeman: Terminal = {
  address: "t1",
  cwd: "/state/worktrees/proj/ts-1",
  state: "finished",
  created_ms: 1,
  status: { state: "working" },
  labels: {
    "fm.fleet": "foreman",
    "fm.task": "ts-1",
    "fm.role": "author",
    "fm.repo": "/build/proj",
  },
};

/** A coordinator's live agent on the same task, started by hand: task label only. */
export const liveHand: Terminal = {
  address: "t2",
  cwd: "/build/proj",
  state: "live",
  created_ms: 2,
  status: { state: "working" },
  labels: { "fm.task": "ts-1" },
};
