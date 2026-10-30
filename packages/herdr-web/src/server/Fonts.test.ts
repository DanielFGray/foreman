import { describe, expect, test } from "vitest"
import { faceRules, familiesOf, parseFontList } from "./Fonts.ts"

// fc-list lines as this machine printed them, in FC_FORMAT.
const lines = [
  "Cascadia Code|180|0|100|100|False|/usr/share/fonts/TTF/CascadiaCode.ttf",
  "Cascadia Code|[40 200]|0|100|100|True|/usr/share/fonts/TTF/CascadiaCode.ttf",
  "Cascadia Code|80|0|100|100|False|/usr/share/fonts/TTF/CascadiaCode.ttf",
  "Cascadia Code|[40 200]|100|100|100|True|/usr/share/fonts/TTF/CascadiaCodeItalic.ttf",
  "DejaVu Sans|200|0|100||False|/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "DejaVu Sans|80|0|87||False|/usr/share/fonts/TTF/DejaVuSansCondensed.ttf",
  "DejaVu Sans|80|110|100||False|/usr/share/fonts/TTF/DejaVuSans-Oblique.ttf",
  "Terminus|80|0|100|100|False|/usr/share/fonts/misc/ter-u12n.otb",
]

describe("parseFontList", () => {
  test("keeps one face per file and slant, a variable font as its weight range", () => {
    expect(parseFontList(lines).map(({ family, weight, isItalic, file }) => [family, weight, isItalic, file.split("/").pop()])).toEqual([
      ["Cascadia Code", [200, 700], false, "CascadiaCode.ttf"],
      ["Cascadia Code", [200, 700], true, "CascadiaCodeItalic.ttf"],
      ["DejaVu Sans", [700, 700], false, "DejaVuSans-Bold.ttf"],
      ["DejaVu Sans", [400, 400], true, "DejaVuSans-Oblique.ttf"],
    ])
  })
})

describe("familiesOf", () => {
  test("lists each family once and marks the monospaced ones", () => {
    expect(familiesOf(parseFontList(lines))).toEqual([
      { name: "Cascadia Code", isMono: true },
      { name: "DejaVu Sans", isMono: false },
    ])
  })
})

describe("faceRules", () => {
  test("points each rule at the face's number", () => {
    const rules = faceRules(parseFontList(lines)).split("\n")
    expect(rules[1]).toBe(
      '@font-face { font-family: "Cascadia Code"; src: url("/fonts/1"); font-weight: 200 700; font-style: italic; font-display: swap; }',
    )
  })
})
