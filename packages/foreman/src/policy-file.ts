/**
 * The policy file: read and rewrite what the operator intends the fleet to do.
 *
 * Schemas and pure rules live in `policy.ts`. This module is the one place that
 * touches the file, through `paths` and `shared-file`, so a browser bundle of
 * the pure rules never pulls Bun's file system.
 */
import { Effect, FileSystem, Option, Schema as S } from "effect";
import { policyPath } from "./paths.ts";
import { DEFAULT_POLICY, Policy, type Policy as PolicyType } from "./policy.ts";
import { rewrite } from "./shared-file.ts";

export { policyPath };

/**
 * The policy as the file states it.
 *
 * A missing file is the default, which takes no step. A file that does not
 * decode is paused, with the reason, because a policy foreman cannot read is
 * not permission for anything, and the operator has to see why the fleet
 * stopped.
 */
export const readPolicy = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(text)) return { policy: DEFAULT_POLICY, error: undefined, text: undefined };
    return yield* S.decodeEffect(S.fromJsonString(Policy))(text.value).pipe(
      Effect.map((policy) => ({ policy, error: undefined, text: text.value })),
      Effect.catch((error) =>
        Effect.succeed({
          policy: { ...DEFAULT_POLICY, paused: true },
          error: `${path} does not decode, so the fleet is paused: ${error.message}`,
          text: text.value,
        }),
      ),
    );
  });

/**
 * Rewrites the policy through `change`, the one way anything writes it.
 *
 * Losing the race `rewrite` describes loses one write: an expiry the
 * dispatcher makes again next tick, an admission that lets a grant take on one
 * task more than its count, or an operator's change that the next reading
 * shows did not happen.
 */
export const updatePolicy = (path: string, change: (policy: PolicyType) => PolicyType) =>
  rewrite(
    path,
    Policy,
    (path) =>
      readPolicy(path).pipe(
        Effect.map(({ policy, error, text }) => ({ value: policy, error, text })),
      ),
    change,
  ).pipe(
    Effect.catchTag("RewriteError", (error) =>
      Effect.fail(new PolicyError({ detail: error.detail })),
    ),
  );

export class PolicyError extends S.TaggedError<PolicyError>()("PolicyError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}
