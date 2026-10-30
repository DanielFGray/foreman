import { Schema as S } from "effect"

/** A font family the bridge can serve; a monospaced one suits a terminal. */
export const FontFamily = S.Struct({ name: S.String, isMono: S.Boolean })
export type FontFamily = typeof FontFamily.Type
