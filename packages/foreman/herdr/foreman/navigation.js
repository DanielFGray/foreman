// What the Pipeline view shows, as two values: the target the pane is aiming
// at ({ project } or { project, definition }) and the reading that answered a
// target. A read captures its target when it is sent and may replace the
// reading only while that target is still the pane's target, so a reading is
// never labelled with a destination it was not asked for. The drawing derives
// from the reading alone; navigation moves the target and leaves the last
// valid reading on screen until the answer to the new target arrives.
export class Navigation {
  constructor() {
    this.target = null;
    // { target, shown }: `shown` is what foreman answered for `target`.
    this.reading = null;
    this.inFlight = false;
    this.stale = false;
  }

  // What `foreman` last answered, or null.
  get shown() {
    return this.reading === null ? null : this.reading.shown;
  }

  // The definition the shown reading is of, or null for the project's pipeline.
  get definition() {
    return this.reading?.target.definition ?? null;
  }

  // Aims at a target. A reading of another project is dropped: it would
  // draw one project's pipeline under another's name.
  go(target) {
    this.target = target;
    if (this.reading !== null && this.reading.target.project !== target?.project)
      this.reading = null;
  }

  // Starts a read of the current target, returning that target; or null when
  // a read is under way, which then repeats once it ends (one foreman process
  // at a time, and the repeat reads the target as it is by then).
  request() {
    if (this.target === null) return null;
    if (this.inFlight) {
      this.stale = true;
      return null;
    }
    this.inFlight = true;
    this.stale = false;
    return this.target;
  }

  // Takes foreman's answer to `sent`; false when the pane aims elsewhere now.
  answer(sent, shown) {
    if (!same(sent, this.target)) return false;
    this.reading = { target: sent, shown };
    return true;
  }

  // The foreman command for the prompt of agent block `id` of what the pane
  // shows: the project's draft, or the definition draft while one is open.
  // Block ids belong to the drawing shown, so the command follows the reading.
  promptArgs(id) {
    const of = this.reading?.target;
    if (of === undefined) return null;
    return of.definition === undefined
      ? ["pipeline", "prompt", of.project, id]
      : ["composite", "prompt", of.definition, id];
  }

  // Ends a read. A read that failed, or was outdated, leaves the pane aiming
  // at what it shows, so the next command addresses the drawing on screen.
  // Returns whether another read is owed.
  settle(sent, answered) {
    this.inFlight = false;
    if (!answered && this.reading !== null && same(sent, this.target))
      this.target = this.reading.target;
    return this.stale;
  }
}

export const same = (a, b) =>
  a !== null &&
  b !== null &&
  a.project === b.project &&
  (a.definition ?? null) === (b.definition ?? null);
