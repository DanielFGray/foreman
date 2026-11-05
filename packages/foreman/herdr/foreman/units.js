// Herdr-app draws a mod's lengths scaled by the person's zoom (`settings().zoom`),
// but reports sizes, bounds and pointer positions unscaled. The pane lays
// out, scrolls and drags in the lengths it draws, so each reported value is
// divided by the zoom where it enters the pane (`Pane.drawn`).
//
// This module uses no herdr-app globals, so `bun test` runs it.

// A reported point, size or bounds in drawn lengths: its own number fields
// divided by `zoom`. An absent value stays absent.
export const drawnAt = (measured, zoom) => measured == null ? measured
  : Object.fromEntries(Object.entries(measured).map(([key, value]) => [key, typeof value === "number" ? value / zoom : value]));
