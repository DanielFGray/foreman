import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { type Modes, scrollInput } from "./terminalScroll.ts"

const plain: Modes = { reports: false, sgr: false, alternate: false, appCursor: false }
const fullScreen: Modes = { reports: true, sgr: true, alternate: true, appCursor: false }

describe("scrollInput", () => {
  test("a program that asked for mouse reports gets a wheel report per line, at the cell", () => {
    expect(scrollInput(fullScreen, -2, { x: 4, y: 9 })).toEqual(Option.some("\x1b[<64;5;10M\x1b[<64;5;10M"))
    expect(scrollInput(fullScreen, 1, { x: 0, y: 0 })).toEqual(Option.some("\x1b[<65;1;1M"))
  })

  test("without SGR reports the cell goes as bytes, held to the last one they can name", () => {
    expect(scrollInput({ ...fullScreen, sgr: false }, -1, { x: 2, y: 300 })).toEqual(Option.some(`\x1b[M${String.fromCharCode(96, 35, 255)}`))
  })

  test("the alternate screen without reports gets arrow keys, in the program's cursor mode", () => {
    expect(scrollInput({ ...plain, alternate: true }, -2, { x: 0, y: 0 })).toEqual(Option.some("\x1b[A\x1b[A"))
    expect(scrollInput({ ...plain, alternate: true, appCursor: true }, 1, { x: 0, y: 0 })).toEqual(Option.some("\x1bOB"))
  })

  test("otherwise, and for no whole line, the terminal scrolls its own scrollback", () => {
    expect(scrollInput(plain, -3, { x: 0, y: 0 })).toEqual(Option.none())
    expect(scrollInput(fullScreen, 0, { x: 0, y: 0 })).toEqual(Option.none())
  })
})
