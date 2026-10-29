import { Effect, Schema } from "effect"

/**
 * A `_tag` for a wire shape that has none: the decoder fills it in and the
 * encoder leaves it out again, so variants can be matched by tag.
 */
export const wireTag = <const T extends string>(tag: T) =>
  Schema.Literal(tag).pipe(Schema.withDecodingDefaultKey(Effect.succeed(tag), { encodingStrategy: "omit" }))
