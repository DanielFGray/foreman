// hc's framed mode. After `hello` with `framed: true`, every message on the
// connection is a frame: channel (u32), kind (u8), payload length (u32), all
// little-endian, then the payload. Channel 0 carries JSON-RPC; a terminal
// stream gets its own channel from `terminal.attach`.
//
// hc documents the frame names but not their layout or numbers; these come
// from the bytes `hc attach` (hc 0.1.14) writes, and the resize layout from
// checking terminal.get after sending one.

export const FrameKind = {
  /** JSON-RPC on channel 0; terminal output, or keys for it, on a stream channel. */
  Data: 0,
  /** The bytes of output the viewer has taken (u32), so hc sends more. */
  Credit: 1,
  /** Ends the stream; empty. */
  Close: 2,
  /** The viewer's size: columns, then rows (u16 each). */
  Resize: 3,
} as const

export type Frame = Readonly<{ channel: number; kind: number; payload: Uint8Array }>

export const encodeFrame = ({ channel, kind, payload }: Frame) => {
  const bytes = new Uint8Array(HEADER + payload.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, channel, true)
  view.setUint8(4, kind)
  view.setUint32(5, payload.length, true)
  bytes.set(payload, HEADER)
  return bytes
}

/** Splits bytes read from the connection into whole frames, and the bytes of a frame not yet complete. */
export const splitFrames = (pending: Uint8Array, chunk: Uint8Array) => {
  const bytes = new Uint8Array(pending.length + chunk.length)
  bytes.set(pending)
  bytes.set(chunk, pending.length)
  const frames: Array<Frame> = []
  let at = 0
  // A loop: a socket read can hold thousands of small output frames.
  while (bytes.length - at >= HEADER) {
    const view = new DataView(bytes.buffer, at)
    const length = view.getUint32(5, true)
    if (bytes.length - at < HEADER + length) break
    frames.push({ channel: view.getUint32(0, true), kind: view.getUint8(4), payload: bytes.slice(at + HEADER, at + HEADER + length) })
    at += HEADER + length
  }
  return { frames, rest: bytes.slice(at) }
}

export const creditPayload = (bytes: number) => {
  const payload = new Uint8Array(4)
  new DataView(payload.buffer).setUint32(0, bytes, true)
  return payload
}

export const resizePayload = (cols: number, rows: number) => {
  const payload = new Uint8Array(4)
  const view = new DataView(payload.buffer)
  view.setUint16(0, cols, true)
  view.setUint16(2, rows, true)
  return payload
}

const HEADER = 9

/** What a framed connection delivers: the hello reply as one JSON line, then frames. */
export type Incoming = Readonly<{ _tag: "Line"; line: string }> | Readonly<{ _tag: "Frame"; frame: Frame }>

export type ReadState = Readonly<{ isFramed: boolean; pending: Uint8Array }>

export const startReading: ReadState = { isFramed: false, pending: new Uint8Array() }

/** Reads one chunk from the connection: the hello line while it is still due, and every whole frame after it. */
export const readConnection = (state: ReadState, chunk: Uint8Array): readonly [ReadState, ReadonlyArray<Incoming>] => {
  if (state.isFramed) {
    const { frames, rest } = splitFrames(state.pending, chunk)
    return [{ isFramed: true, pending: rest }, frames.map((frame) => ({ _tag: "Frame", frame }))]
  }
  const bytes = new Uint8Array(state.pending.length + chunk.length)
  bytes.set(state.pending)
  bytes.set(chunk, state.pending.length)
  const end = bytes.indexOf(NEWLINE)
  if (end < 0) return [{ isFramed: false, pending: bytes }, []]
  const line: Incoming = { _tag: "Line", line: new TextDecoder().decode(bytes.subarray(0, end)) }
  const [framed, frames] = readConnection({ isFramed: true, pending: new Uint8Array() }, bytes.subarray(end + 1))
  return [framed, [line, ...frames]]
}

const NEWLINE = 0x0a
