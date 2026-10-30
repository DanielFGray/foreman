import { Schema } from "effect"

/** A font family the bridge can serve; a monospaced one suits a terminal. */
export const FontFamily = Schema.Struct({ name: Schema.String, isMono: Schema.Boolean })
export type FontFamily = typeof FontFamily.Type
