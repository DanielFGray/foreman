// The exits of an agent or a check as the inspector lists them, and what each
// may be changed to. This module uses no herdr-app globals, so `bun test` runs it.

// The `to` of an exit that returns the task to the queue, as foreman's
// pipeline names it.
export const QUEUE = "queue";

// Each exit of `node`: its name, where it leads (or that it returns the task to
// the queue), the rung it charges and the charges it may take, what an empty
// branch on it means and the meanings it may take, and whether its name is
// fixed. Only an author's exit may charge `self`: a reviewer and a check have
// no rung. Only an author's branch can be empty of its own
// work, so only an author's exit may be the claim that trunk already does the
// task. A check's exits are always passed and failed.
export const exitRows = (node) => {
  const author = node.kind === "agent" && node.role === "author";
  const charges = author ? ["none", "author", "self"] : ["none", "author"];
  return node.exits.map((exit) => ({
    name: exit.name,
    to: exit.to,
    returns: exit.to === QUEUE,
    fails: exit.fails ?? "none",
    charges,
    empty: exit.empty ?? "unfinished",
    empties: author ? ["unfinished", "claim"] : [],
    fixed: node.kind === "check",
  }));
};

// The `ChargeExit` change a charge choice sends: "none" clears the charge.
export const chargeChange = (node, name, choice) => ({
  _tag: "ChargeExit",
  id: node.id,
  name,
  ...(choice === "none" ? {} : { fails: choice }),
});

// The `SetEmpty` change an empty-branch choice sends: "unfinished" clears the claim.
export const emptyChange = (node, name, choice) => ({
  _tag: "SetEmpty",
  id: node.id,
  name,
  ...(choice === "claim" ? { empty: "claim" } : {}),
});
