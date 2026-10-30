// What every usage provider needs: its sign-in file, one GET to its service,
// and the service's reply decoded. A provider that finds no sign-in reads as
// none, and is not shown.
import { Duration, Effect, FileSystem, Match, Option, Schema } from "effect"
import { HttpClient } from "effect/http"
import type { UsageReport } from "../../shared/Usage.ts"

/**
 * A read that failed. `rejected` means the service refused the sign-in, and
 * `rate_limited` that it asked to be asked less often: each waits longer
 * before the next read.
 */
export class UsageError extends Schema.TaggedError<UsageError, { readonly brand: unique symbol }>()("UsageError", {
  kind: Schema.Literals(["rejected", "rate_limited", "http", "invalid"]),
  message: Schema.String,
}) {}

export type ReadReport = Effect.Effect<
  Option.Option<UsageReport>,
  UsageError,
  FileSystem.FileSystem | HttpClient.HttpClient
>

/** The file's text, or none when it is not there: the agent is not signed in. */
export const readOptionalFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(path).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
      Effect.mapError((error) => new UsageError({ kind: "invalid", message: `cannot read ${path}: ${error.message}` })),
    )
  })

/** The JSON text decoded, or none when it does not match: a sign-in file this reader does not know. */
export const decodeOptional =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (text: Option.Option<string>): Option.Option<S["Type"]> =>
    Option.flatMap(text, Schema.decodeOption(Schema.fromJsonString(schema)))

/** The reply's body, decoded; a refusal, a rate limit or another failure as its UsageError. */
export const getJson = <S extends Schema.ConstraintDecoder<unknown>>(url: string, headers: Readonly<Record<string, string>>, schema: S) =>
  getReply(url, headers).pipe(
    Effect.flatMap(({ status, text }) => replyBody(status, text)),
    Effect.flatMap((text) => decodeReply(schema, text)),
  )

/**
 * The reply's status and body, whatever the status. The error says only what
 * failed: the request it carries holds the sign-in, so it is never logged.
 */
export const getReply = (url: string, headers: Readonly<Record<string, string>>) =>
  HttpClient.get(url, { headers }).pipe(
    Effect.flatMap((response) => Effect.map(response.text, (text) => ({ status: response.status, text }))),
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.catchTags({
      HttpClientError: (error) => Effect.fail(new UsageError({ kind: "http", message: `${new URL(url).host}: ${error.reason._tag}` })),
      TimeoutError: () => Effect.fail(new UsageError({ kind: "http", message: `${new URL(url).host} did not answer` })),
    }),
  )

const REQUEST_TIMEOUT = Duration.seconds(20)

export const decodeReply = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, text: string): Effect.Effect<S["Type"], UsageError> =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError((error) => new UsageError({ kind: "invalid", message: `unexpected reply: ${error.message}` })),
  )

/** The body of a good reply; a service's own error message when it refuses. */
export const replyBody = (status: number, text: string): Effect.Effect<string, UsageError> =>
  Match.value(status).pipe(
    Match.when(
      (code) => code === 401 || code === 403,
      () =>
        Effect.fail(
          new UsageError({
            kind: "rejected",
            message: Option.getOrElse(
              Option.map(Schema.decodeOption(Schema.fromJsonString(ServiceError))(text), ({ error }) => error.message),
              () => `sign-in rejected (${status})`,
            ),
          }),
        ),
    ),
    Match.when(429, () => Effect.fail(new UsageError({ kind: "rate_limited", message: "rate limited" }))),
    Match.when((code) => code >= 200 && code < 300, () => Effect.succeed(text)),
    Match.orElse(() => Effect.fail(new UsageError({ kind: "http", message: `HTTP ${status}` }))),
  )

/** The error a service sends with a refusal. */
export const ServiceError = Schema.Struct({
  error: Schema.Struct({ type: Schema.OptionFromOptionalNullOr(Schema.String), message: Schema.String }),
})

/**
 * A time as services send it: epoch seconds or milliseconds, as a number or
 * text, or an ISO date. None when it is none of these.
 */
export const parseTime = (value: string | number): Option.Option<number> =>
  typeof value === "number" || /^\s*-?[\d.]+\s*$/.test(value) ? epochOf(Number(value)) : isoDate(value)

// Seconds and milliseconds overlap nowhere a service would send: 1e11 seconds
// is the year 5138.
const epochOf = (n: number) =>
  Option.map(
    Option.liftPredicate(n, (time) => Number.isFinite(time) && time > 0),
    (time) => (time > 1e11 ? time : time * 1000),
  )

/** An ISO date; one without a zone is UTC. */
const isoDate = (text: string) =>
  Option.liftPredicate(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(" ", "T")}Z`), (ms) => !Number.isNaN(ms))

/** `pro_plus` as `Pro Plus`. */
export const titleCase = (text: string) =>
  text
    .split(/[_\s-]+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ")

export const SESSION = 5 * 3600e3
export const WEEK = 7 * 86400e3
export const MONTH = 30 * 86400e3

/** Where the agents keep their sign-ins, from the environment, read once. */
export type UsageEnv = Readonly<{
  home: string
  claudeDir: string
  codexHome: string
  dataHome: string
  anthropicBaseUrl: Option.Option<string>
  opencodeKey: Option.Option<string>
}>

/** A time a service sends: epoch seconds or milliseconds, or an ISO date. */
export const Time = Schema.Union([Schema.Finite, Schema.String])
