// The editor's text settings, and which of them a reading changed. This module
// uses no herdr-app globals, so `bun test` runs it.

// Each text setting: its label, what the empty input says, and the value it
// starts with for a block (`when`, `newRoute`, `newSource`, `exitName` and
// `newExit` always start empty).
export const FIELDS = {
  filter: { label: "filter", placeholder: "empty takes every task", of: (node) => node.filter },
  model: { label: "model", placeholder: "ladder, above, or a rung's name", of: (node) => node.model },
  slots: { label: "slots", placeholder: "how many at once; empty is no limit", of: (node) => node.slots ?? "" },
  command: { label: "command", placeholder: "the command that must pass", of: (node) => node.command },
  when: { label: "when", placeholder: "a tasks filter", of: () => "" },
  newRoute: { label: "new route", placeholder: "a tasks filter, then Enter", of: () => "" },
  newSource: { label: "filter", placeholder: "a tasks filter; empty takes every task", of: () => "" },
  exitName: { label: "name", placeholder: "lower-case words and hyphens, then Enter", of: () => "" },
  newExit: { label: "new exit", placeholder: "a name for the agent to end its run with, then Enter", of: () => "" },
};

// What each input shows for a block, or for no block.
export const settingsOf = (node) =>
  Object.entries(FIELDS).map(([key, field]) => [key, node === undefined ? "" : String(field.of(node) ?? "")]);

// The inputs a reading refills: each setting of the selected block that the
// reading changed, such as by a discard or a save. The rest may hold text the
// operator has not sent yet, so they keep it.
export const changedSettings = (before, after) => {
  if (after === undefined) return [];
  const was = new Map(settingsOf(before));
  return settingsOf(after).filter(([key, value]) => before === undefined || was.get(key) !== value);
};
