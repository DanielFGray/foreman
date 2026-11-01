// The fonts installed on this computer, offered to the page: a phone has none
// of the desktop's fonts, so the bridge serves them. fontconfig lists them
// once, at start; a font file is served only by its number in that list, so
// the routes reach no other file.
import { Array, Context, Effect, Layer, Option, Order, pipe, Record, Schema as S } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { FontFamily } from "../shared/Fonts.ts"

/** One file of a family: a weight, or a range for a variable font, upright or italic. */
export type Face = Readonly<{
  family: string
  weight: readonly [number, number]
  isItalic: boolean
  isMono: boolean
  file: string
}>

export class Fonts extends Context.Service<Fonts>()("herdr-web/server/Fonts", {
  make: Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const faces = yield* spawner.lines(ChildProcess.make("fc-list", ["--format", `${FC_FORMAT}\n`])).pipe(
      Effect.map(parseFontList),
      // A computer without fontconfig still has the browser's own fonts.
      Effect.catchTag("PlatformError", (error) =>
        Effect.logWarning("fc-list did not run; the page offers only its own fonts", error).pipe(Effect.as([])),
      ),
    )
    return { faces, families: familiesOf(faces), css: faceRules(faces) }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

/** `/fonts.css`, the @font-face rule of every face, and `/fonts/<n>`, its file. */
export const FontRoutes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/fonts.css",
    Effect.gen(function* () {
      const { css } = yield* Fonts
      return HttpServerResponse.text(css, { contentType: "text/css" })
    }),
  ),
  HttpRouter.add(
    "GET",
    "/fonts/:n",
    Effect.gen(function* () {
      const { faces } = yield* Fonts
      const { n } = yield* HttpRouter.schemaPathParams(S.Struct({ n: S.FiniteFromString }))
      return yield* Option.match(Array.get(faces, n), {
        onNone: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
        onSome: ({ file }) =>
          HttpServerResponse.file(file, { headers: { "cache-control": "max-age=86400" } }),
      })
    }).pipe(Effect.catchTag("SchemaError", () => Effect.succeed(HttpServerResponse.empty({ status: 404 })))),
  ),
)

const FC_FORMAT = "%{family[0]}|%{weight}|%{slant}|%{width}|%{spacing}|%{variable}|%{file}"

/**
 * Reads `fc-list` lines in FC_FORMAT. Keeps TrueType and OpenType files of
 * normal width, one face per file and slant: fontconfig lists a variable font
 * once with its weight range and again for each named weight, all one file.
 */
export const parseFontList = (lines: ReadonlyArray<string>): ReadonlyArray<Face> =>
  pipe(
    lines,
    Array.map((line) => {
      const [family, weight, slant, width, spacing, variable, file] = line.split("|")
      return family && weight && file && width === "100" && /\.(ttf|otf)$/i.test(file)
        ? Option.some({
            family,
            weight: weightRange(weight),
            isItalic: Number(slant) > 0,
            isMono: Number(spacing) >= MONO_DUAL,
            isVariable: variable === "True",
            file,
          })
        : Option.none()
    }),
    Array.getSomes,
    Array.groupBy(({ family, file, isItalic }) => `${family}\u0000${file}\u0000${isItalic}`),
    Record.values,
    Array.map((entries) => {
      const chosen = Option.getOrElse(Array.findFirst(entries, ({ isVariable }) => isVariable), () => Array.headNonEmpty(entries))
      return { family: chosen.family, weight: chosen.weight, isItalic: chosen.isItalic, isMono: chosen.isMono, file: chosen.file }
    }),
    Array.sort(Order.mapInput(Order.String, ({ family, file }: Face) => `${family}\u0000${file}`)),
  )

/** Each family once, by name; monospaced when any of its faces is. */
export const familiesOf = (faces: ReadonlyArray<Face>): ReadonlyArray<FontFamily> =>
  pipe(
    faces,
    Array.groupBy(({ family }) => family),
    Record.values,
    Array.map((group) => ({ name: Array.headNonEmpty(group).family, isMono: group.some(({ isMono }) => isMono) })),
    Array.sort(Order.mapInput(Order.String, ({ name }: FontFamily) => name)),
  )

/** The @font-face rules; a browser fetches a face's file only when the page uses it. */
export const faceRules = (faces: ReadonlyArray<Face>) =>
  faces
    .map(
      ({ family, weight: [low, high], isItalic }, n) =>
        `@font-face { font-family: ${JSON.stringify(family)}; src: url("/fonts/${n}"); font-weight: ${low === high ? low : `${low} ${high}`}; font-style: ${isItalic ? "italic" : "normal"}; font-display: swap; }`,
    )
    .join("\n")

/** fontconfig's spacing for a dual-width font, such as a Nerd Font: monospaced with wide icons. */
const MONO_DUAL = 90

/** A fontconfig weight (`80`) or range (`[40 200]`) as CSS weights. */
const weightRange = (text: string): readonly [number, number] => {
  const [low, high = low] = text.replace(/[[\]]/g, "").split(" ").map((n) => cssWeight(Number(n)))
  return [low ?? 400, high ?? 400]
}

// fontconfig's weight scale against the CSS one, from fontconfig's
// FcWeightToOpenType; weights between two points are interpolated.
const WEIGHTS: ReadonlyArray<readonly [number, number]> = [
  [0, 100], [40, 200], [50, 300], [55, 350], [75, 380], [80, 400], [100, 500], [180, 600], [200, 700], [205, 800], [210, 900], [215, 950],
]

const cssWeight = (fc: number) =>
  pipe(
    Array.zip(WEIGHTS, Array.drop(WEIGHTS, 1)),
    Array.findFirst(([[low], [high]]) => fc >= low && fc <= high),
    Option.match({
      onNone: () => (fc < 0 ? 100 : 950),
      onSome: ([[fcLow, cssLow], [fcHigh, cssHigh]]) =>
        Math.round(cssLow + ((fc - fcLow) * (cssHigh - cssLow)) / (fcHigh - fcLow)),
    }),
  )
