// Who may talk to the bridge. The bridge can type into the user's shells, so
// a request it serves is as strong as a shell.
//
// The server listens on loopback unless HOST names another address; remote
// use goes through an SSH tunnel or Tailscale. Loopback alone is not enough: any page in the user's browser
// can dial 127.0.0.1, and a DNS-rebinding page reaches it under its own host
// name. So every request must name an allowed Host, and a request from a page
// (one with an Origin) must come from an allowed origin.
import { Config, Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

/** The address the server listens on unless HOST names another. */
const LOOPBACK = "127.0.0.1"

/** The address the server listens on. */
export const Host = Config.String("HOST").pipe(Config.withDefault(LOOPBACK))

/**
 * The Host names a request may use: loopback names and the address the server
 * listens on, plus any set in HERDR_WEB_HOSTS (comma separated, e.g. a
 * Tailscale name).
 */
export const allowedHosts = (host: string, port: number, extra: ReadonlyArray<string>) =>
  new Set([...["localhost", "127.0.0.1", "[::1]", host].map((name) => `${name}:${port}`), ...extra])

/** Whether a request with these Host and Origin headers may be served. */
export const isAllowed = (hosts: ReadonlySet<string>, host: Option.Option<string>, origin: Option.Option<string>) =>
  Option.exists(host, (h) => hosts.has(h)) &&
  Option.match(origin, {
    // Navigation and non-browser clients send no Origin; the Host check covers them.
    onNone: () => true,
    onSome: (o) => Option.exists(hostOf(o), (h) => hosts.has(h)),
  })

/** The `host:port` of an origin such as `http://localhost:4180`; None when it is not an http(s) URL. */
const hostOf = (origin: string) =>
  Option.liftThrowable(() => new URL(origin))().pipe(
    Option.filter((url) => url.protocol === "http:" || url.protocol === "https:"),
    Option.map((url) => url.host),
  )

export const ExtraHosts = Config.String("HERDR_WEB_HOSTS").pipe(
  Config.map((list) => list.split(",").map((h) => h.trim()).filter((h) => h.length > 0)),
  Config.withDefault([]),
)

/** Refuses, with 403, every request whose Host or Origin is not allowed. */
export const guard = (host: string, port: number) =>
  HttpRouter.middleware(
    Effect.gen(function* () {
      const hosts = allowedHosts(host, port, yield* ExtraHosts)
      return (app) =>
        Effect.gen(function* () {
          const { headers } = yield* HttpServerRequest.HttpServerRequest
          const header = (name: string) => Option.fromNullishOr(headers[name])
          return isAllowed(hosts, header("host"), header("origin"))
            ? yield* app
            : HttpServerResponse.text("Forbidden: this host or origin may not use the bridge", { status: 403 })
        })
    }),
    { global: true },
  )
