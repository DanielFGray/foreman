// The exits of an agent or a check as the inspector lists them, and what each
// may be changed to. This module uses no herdr-app globals, so `bun test` runs it.

// The `to` of an exit that returns the task to the queue, as foreman's
// pipeline names it.
export const QUEUE = "queue";

// Each exit of `node`: its name, where it leads (or that it returns the task to
// the queue), the rung it charges and the charges it may take, and whether its
// name is fixed. A reviewer is no rung, and neither is a check, so only an
// author's exit may charge `self`; a check's exits are always passed and failed.
export const exitRows = (node) => {
  const charges = node.kind === "agent" && node.role === "author" ? ["none", "author", "self"] : ["none", "author"];
  return node.exits.map((exit) => ({
    name: exit.name,
    to: exit.to,
    returns: exit.to === QUEUE,
    fails: exit.fails ?? "none",
    charges,
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
