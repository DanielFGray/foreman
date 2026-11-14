import { Cause, Option } from "effect";

/** The reason an RPC call failed, as the operator reads it: the error's own message, else the whole cause. */
export const reasonOf = <E extends { readonly message: string }>(cause: Cause.Cause<E>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => Cause.pretty(cause),
    onSome: (error) => error.message,
  });
