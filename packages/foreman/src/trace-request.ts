/**
 * What `foreman pipeline trace` reads, and what the UI contract sends: the
 * pretend task and the events chosen so far. Pure, so the page can import it.
 */
import { Effect, Schema as S } from "effect";

export const TraceRequest = S.Struct({
  task: S.Struct({
    labels: S.Array(S.String).pipe(S.withDecodingDefault(Effect.succeed([]))),
    size: S.optional(S.Int),
    priority: S.Int.pipe(S.withDecodingDefault(Effect.succeed(2))),
    parent: S.optional(S.String),
  }),
  events: S.Array(S.String).pipe(S.withDecodingDefault(Effect.succeed([]))),
});
export type TraceRequest = typeof TraceRequest.Type;
