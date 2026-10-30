import { Array, Option, Result } from "effect"
import { describe, expect, test } from "vitest"
import { applyModifiers, characterKey, keyLabel, modifiersAttribute, NO_MODIFIERS, NO_SHEET_MODIFIERS, parseModifiersAttribute, withModifiers } from "./keys.ts"
import { chosenKey } from "./keySheet.ts"

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

describe("the Send keys sheet's keys", () => {
  test("a key's chip shows arrows and Enter as symbols, ctrl with one character as ^C, and the rest by name", () => {
    expect(Array.map(["left", "enter", "ctrl+c", "f5", "ctrl+shift+tab", "alt+up", "y"], keyLabel)).toEqual(["←", "⏎", "^C", "F5", "ctrl+shift+tab", "alt+↑", "y"])
  })

  test("a typed character is one hc can name, or the reason it is not", () => {
    expect(Array.map(["r", "7", "/", "R", "!", ""], characterKey)).toEqual([
      Result.succeed("r"),
      Result.succeed("7"),
      Result.succeed("/"),
      Result.fail("Type r and turn on Shift."),
      Result.fail("hc cannot send !; it takes a letter, a digit, or one of ` \\ [ ] , = - . ' ; /"),
      Result.fail("Type one character."),
    ])
  })

  test("the chosen key is named with its modifiers in hc's order", () => {
    const modifiers = { ...NO_SHEET_MODIFIERS, shift: true, ctrl: true }
    expect([
      chosenKey({ group: "F keys", named: "f5", typed: "", modifiers }),
      chosenKey({ group: "Character", named: "esc", typed: "r", modifiers }),
      chosenKey({ group: "Character", named: "esc", typed: "", modifiers }),
    ]).toEqual([Result.succeed("ctrl+shift+f5"), Result.succeed("ctrl+shift+r"), Result.fail("Type one character.")])
  })
})
