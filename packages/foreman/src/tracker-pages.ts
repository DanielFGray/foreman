import { Effect } from "effect";

export interface TrackerPage<A> {
  readonly nodes: ReadonlyArray<A>;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

/** Reads every cursor page and fails if a tracker claims another page without its cursor. */
export const allTrackerPages = <A, E>(
  read: (after: string | undefined) => Effect.Effect<TrackerPage<A>, E>,
  missingCursor: () => E,
) =>
  Effect.gen(function* () {
    const nodes: Array<A> = [];
    let after: string | undefined;
    while (true) {
      const page = yield* read(after);
      nodes.push(...page.nodes);
      if (!page.hasNextPage) return nodes;
      if (page.endCursor === null) return yield* Effect.fail(missingCursor());
      after = page.endCursor;
    }
  });
