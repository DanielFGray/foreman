// The bridge's sign-in to the OpenCode server on its own machine, and the
// calls it makes there. The server takes a password from its own config, which
// the bridge never reads. Instead `opencode pair`, OpenCode's own program,
// issues a one-time code in a link, and the bridge trades the link for a token
// that the server takes in the password's place for 30 days. The token stays
// in the bridge's config folder, which only the user may read. The server
// refuses a token that expired or that a new password made void; the bridge
// then deletes it, and the page offers to pair again.
import { Array, Config, Context, Effect, FileSystem, Layer, Option, Redacted, Schema as S, Semaphore } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Hc } from "../../hc/Hc.ts"
import { BridgeError } from "../../shared/Api.ts"
import { toBridgeError } from "../hcError.ts"

export class OpenCodeServer extends Context.Service<OpenCodeServer>()("herdr-web/server/opencode/OpenCodeServer", {
  make: Effect.gen(function* () {
    const hc = yield* Hc
    const fs = yield* FileSystem.FileSystem
    const http = yield* HttpClient.HttpClient
    const folder = yield* Config.String("XDG_CONFIG_HOME").pipe(
      Config.orElse(() => Config.String("HOME").pipe(Config.map((home) => `${home}/.config`))),
      Config.map((config) => `${config}/herdr-web`),
    )
    const file = `${folder}/opencode-pairing.json`
    // Two pages that pair at once would each issue a code; one of them is enough.
    const lock = yield* Semaphore.make(1)

    const stored = fs.readFileString(file).pipe(
      Effect.flatMap(S.decodeEffect(S.fromJsonString(Pairing))),
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.mapError(() => new BridgeError({ kind: "unpaired", message: `the bridge's sign-in to OpenCode, ${file}, cannot be read; pair again` })),
    )

    // Written beside the old file and moved over it, so a reader never finds half a file.
    const save = (pairing: Pairing) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 })
        const written = `${file}.new`
        yield* fs.remove(written).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void))
        const text = yield* S.encodeEffect(S.fromJsonString(Pairing))(pairing)
        yield* fs.writeFileString(written, text, { flag: "wx", mode: 0o600 })
        yield* fs.rename(written, file)
      }).pipe(Effect.mapError(({ message }) => new BridgeError({ kind: "pairing", message: `the sign-in cannot be saved: ${message}` })))

    const forget = fs.remove(file).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void), Effect.ignore)

    // The response is never put in an error: before the bridge reads it, it may hold the token.
    const send = (request: HttpClientRequest.HttpClientRequest) =>
      http.execute(request).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(() => new BridgeError({ kind: "opencode-server", message: `OpenCode's server at ${new URL(request.url).host} did not answer` })),
      )

    /**
     * The server's response to the request `build` makes for its address,
     * sent with the stored token, when its status is a success. A refused
     * token is forgotten, so the next call asks to pair.
     */
    const call = <E, R>(build: (url: string) => Effect.Effect<HttpClientRequest.HttpClientRequest, E, R>) =>
      Effect.gen(function* () {
        const pairing = yield* Effect.flatMap(stored, Effect.fromOption).pipe(
          Effect.catchTag("NoSuchElementError", () => Effect.fail(new BridgeError({ kind: "unpaired", message: "the bridge is not paired with OpenCode's server yet" }))),
        )
        const request = yield* build(pairing.url)
        const response = yield* send(request.pipe(HttpClientRequest.acceptJson, HttpClientRequest.basicAuth(USERNAME, Redacted.make(pairing.token))))
        if (response.status === 401) {
          yield* forget
          return yield* new BridgeError({ kind: "unpaired", message: "OpenCode's server no longer takes the bridge's sign-in" })
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* new BridgeError({ kind: "opencode-server", message: `OpenCode's server refused the call with status ${response.status}` })
        }
        return response
      })

    return {
      /**
       * Pairs the bridge with the OpenCode server on its own machine: issues a
       * code with `opencode pair`, trades it for a token, and keeps the token.
       */
      pair: Semaphore.withPermit(
        lock,
        Effect.gen(function* () {
          const { stdout, code } = yield* Effect.mapError(hc.exec({ argv: ["opencode", "pair"], cwd: Option.none(), on: Option.none(), timeout: Option.some(PAIR_TIMEOUT) }), toBridgeError)
          if (!Option.contains(code, 0)) {
            return yield* new BridgeError({ kind: "pairing", message: "`opencode pair` failed; is OpenCode's background service running?" })
          }
          const link = yield* Effect.fromOption(pairingLink(stdout)).pipe(
            Effect.mapError(() => new BridgeError({ kind: "pairing", message: "`opencode pair` printed no link to this machine's server" })),
          )
          const response = yield* send(HttpClientRequest.get(link.href).pipe(HttpClientRequest.acceptJson))
          if (response.status < 200 || response.status >= 300) {
            return yield* new BridgeError({ kind: "pairing", message: `OpenCode's server refused the pairing code with status ${response.status}` })
          }
          const { token } = yield* Effect.flatMap(response.json, S.decodeUnknownEffect(PairingSession)).pipe(
            Effect.mapError(() => new BridgeError({ kind: "pairing", message: "OpenCode's server sent no token for the pairing code" })),
          )
          yield* save({ url: link.origin, token })
        }),
      ),
      /** A GET of `path` on the server, with `params` in its query, decoded with `schema`. */
      get: <S extends S.ConstraintDecoder<unknown>>(path: string, params: Readonly<Record<string, string>>, schema: S) =>
        call((url) => Effect.succeed(HttpClientRequest.get(`${url}${path}`).pipe(HttpClientRequest.setUrlParams(params)))).pipe(
          Effect.flatMap((response) => Effect.flatMap(response.json, S.decodeUnknownEffect(schema))),
          Effect.catchTags({
            HttpClientError: () => Effect.fail(new BridgeError({ kind: "opencode-server", message: "OpenCode's server sent no JSON" })),
            SchemaError: ({ message }) => Effect.fail(new BridgeError({ kind: "opencode-server", message: `OpenCode's server sent a reply the bridge cannot read: ${message}` })),
          }),
        ),
      /** A POST of `body`, encoded with `schema`, to `path` on the server; what the server answers is not read. */
      post: <S extends S.Constraint>(path: string, schema: S, body: S["Type"]) =>
        call((url) =>
          HttpClientRequest.schemaBodyJson(schema)(HttpClientRequest.post(`${url}${path}`), body).pipe(
            Effect.mapError(() => new BridgeError({ kind: "opencode-server", message: `the call to ${path} cannot be encoded` })),
          ),
        ).pipe(Effect.asVoid),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

/**
 * The link in what `opencode pair` prints that reaches the server on this
 * machine: the one at a loopback address. The others are for other devices.
 */
export const pairingLink = (printed: string): Option.Option<URL> =>
  Array.findFirst(
    Array.getSomes(Array.map(printed.split("\n"), (line) => Option.fromNullOr(URL.parse(line.trim())))),
    (url) => url.protocol === "http:" && Array.contains(LOOPBACK, url.hostname) && CONNECT.test(url.pathname),
  )

/** What the bridge keeps: the server's address, and the token it takes. */
const Pairing = S.Struct({ url: S.String, token: S.String })
type Pairing = typeof Pairing.Type

/** What the server answers a pairing link with, for a caller that accepts JSON. */
const PairingSession = S.Struct({ token: S.String })

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"]

const CONNECT = /^\/auth\/connect\/[\w-]+$/

/** The server's own user name; the token stands in for its password. */
const USERNAME = "opencode"

const REQUEST_TIMEOUT = "10 seconds"

/** Seconds `opencode pair` may take, starting OpenCode's background service when it is not running. */
const PAIR_TIMEOUT = 30
