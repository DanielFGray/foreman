import { Effect, Layer } from "effect";
import { Machine } from "./machine.ts";
import { Prompts } from "./prompt.ts";
import { Quota } from "./quota.ts";

/**
 * The host services a one-shot Dispatcher needs beyond the store and the
 * fleet, for tests: a Quota that reports no allowance and asks no provider, so
 * a test never reaches the network, with the real prompt templates and memory
 * reading.
 */
export const offlineHost = Layer.mergeAll(
  Prompts.Default,
  Machine.Default,
  Layer.succeed(Quota, {
    usage: (provider: string) => Effect.succeed({ provider, plan: undefined, allowances: [] }),
  }),
);
