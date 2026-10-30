import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { applyModifiers, modifiersAttribute, NO_MODIFIERS, parseModifiersAttribute, withModifiers } from "./keys.ts"

const ctrl = { ctrl: true, alt: false }
const alt = { ctrl: false, alt: true }

describe("withModifiers", () => {
  test("names the key as hc does", () => {
    expect(withModifiers("left", { ctrl: true, alt: true })).toBe("ctrl+alt+left")
    expect(withModifiers("tab", NO_MODIFIERS)).toBe("tab")
  })
})

describe("applyModifiers", () => {
  test("ctrl gives a letter's control code, whatever its case", () => {
    expect(applyModifiers("c", ctrl)).toEqual(Option.some("\u0003"))
    expect(applyModifiers("C", ctrl)).toEqual(Option.some("\u0003"))
    expect(applyModifiers("[", ctrl)).toEqual(Option.some("\u001b"))
  })

  test("alt sends ESC before the key, and with ctrl before its control code", () => {
    expect(applyModifiers("b", alt)).toEqual(Option.some("\u001bb"))
    expect(applyModifiers("x", { ctrl: true, alt: true })).toEqual(Option.some("\u001b\u0018"))
  })

  test("leaves a paste, a key ctrl cannot change, and unarmed keys alone", () => {
    expect(applyModifiers("ls", ctrl)).toEqual(Option.none())
    expect(applyModifiers("1", ctrl)).toEqual(Option.none())
    expect(applyModifiers("c", NO_MODIFIERS)).toEqual(Option.none())
  })
})

test("the attribute carries the modifiers to the terminal and back", () => {
  expect(parseModifiersAttribute(modifiersAttribute({ ctrl: true, alt: true }))).toEqual({ ctrl: true, alt: true })
  expect(parseModifiersAttribute(modifiersAttribute(NO_MODIFIERS))).toEqual(NO_MODIFIERS)
})
