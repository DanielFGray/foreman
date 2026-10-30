import { describe, expect, test } from "vitest"
import { encodeFrame, FrameKind, readConnection, resizePayload, splitFrames, startReading } from "./Frame.ts"

const bytes = (...values: ReadonlyArray<number>) => Uint8Array.from(values)
const text = (value: string) => new TextEncoder().encode(value)

// Frames as `hc attach` wrote them to the socket.
const typed = Uint8Array.from([...bytes(1, 0, 0, 0, 0, 8, 0, 0, 0), ...text("echo hi\r")])
const credit = bytes(1, 0, 0, 0, 1, 4, 0, 0, 0, 0x61, 0x01, 0, 0)

describe("encodeFrame", () => {
  test("writes channel, kind and length before the payload, as hc does", () => {
    expect(encodeFrame({ channel: 1, kind: FrameKind.Data, payload: text("echo hi\r") })).toEqual(typed)
    expect(encodeFrame({ channel: 1, kind: FrameKind.Credit, payload: bytes(0x61, 0x01, 0, 0) })).toEqual(credit)
  })

  test("a resize carries columns, then rows, as 16-bit numbers", () => {
    expect(resizePayload(77, 21)).toEqual(bytes(77, 0, 21, 0))
  })
})

describe("splitFrames", () => {
  test("reads each whole frame and keeps a partial one for the next chunk", () => {
    const chunk = Uint8Array.from([...typed, ...credit.subarray(0, 5)])
    const first = splitFrames(new Uint8Array(), chunk)
    expect(first.frames).toEqual([{ channel: 1, kind: FrameKind.Data, payload: text("echo hi\r") }])
    const second = splitFrames(first.rest, credit.subarray(5))
    expect(second.frames).toEqual([{ channel: 1, kind: FrameKind.Credit, payload: bytes(0x61, 0x01, 0, 0) }])
    expect(second.rest).toEqual(new Uint8Array())
  })

  test("an empty payload is a whole frame", () => {
    expect(splitFrames(new Uint8Array(), bytes(1, 0, 0, 0, 2, 0, 0, 0, 0)).frames).toEqual([
      { channel: 1, kind: FrameKind.Close, payload: new Uint8Array() },
    ])
  })
})

describe("readConnection", () => {
  test("reads the hello reply line, then frames, from one chunk", () => {
    const chunk = Uint8Array.from([...text('{"id":"0"}\n'), ...typed])
    const [state, incoming] = readConnection(startReading, chunk)
    expect(incoming).toEqual([
      { _tag: "Line", line: '{"id":"0"}' },
      { _tag: "Frame", frame: { channel: 1, kind: FrameKind.Data, payload: text("echo hi\r") } },
    ])
    expect(state).toEqual({ isFramed: true, pending: new Uint8Array() })
  })

  test("waits for the rest of a hello line split across chunks", () => {
    const [state, incoming] = readConnection(startReading, text('{"id"'))
    expect(incoming).toEqual([])
    expect(readConnection(state, text(':"0"}\n'))[1]).toEqual([{ _tag: "Line", line: '{"id":"0"}' }])
  })
})
