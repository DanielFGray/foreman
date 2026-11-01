import { FetchHttpClient } from "effect/http";
import { OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/observability";
import { hostname } from "node:os";
import { Effect, Layer } from "effect";
import { Settings } from "./config.ts";

/**
 * What foreman calls itself wherever it is not the only thing running.
 *
 * The CLI's version and the `service.version` on every span are the same claim,
 * so they are the same constant. Stating it twice is how the two drift.
 */
export const VERSION = "0.1.0";

/**
 * Spans and metrics to a collector, over OTLP.
 *
 * A run of the ladder — author, review, land — is a span with a start, an end
 * and an outcome. That is what the escalation questions are actually about: how
 * long a rung takes, how often it is sent back, what a climb buys. Pairing log
 * lines back into runs would rebuild tracing badly, so foreman emits spans and
 * the collector keeps the history.
 *
 * The endpoint is a local collector, never a remote host. Which gateway that
 * collector forwards to, whether it is reachable, and how long its queue holds
 * are all the collector's concerns, and keeping them there is what lets the
 * gateway move without foreman being touched.
 *
 * **An unreachable collector must never be a stalled fleet.** It is not: the
 * exporter batches onto its own fiber, so no tick ever waits for an export, and
 * a failed export disables the exporter for a minute rather than failing. That
 * is why the error channel is `never` — lost telemetry is the intended outcome
 * of a collector being off, not a fault to surface.
 *
 * It also matters that the exporter reports trouble at debug level through
 * Effect's logger, which foreman has replaced with a file. A telemetry layer
 * writing to the terminal would tear the dashboard, which owns it.
 *
 * Traces and metrics only. `effect/observability` also ships `OtlpLogger`, but
 * foreman's log is one file that the dashboard reads back, and a second
 * destination for it is a separate decision from measuring the ladder.
 */
export const telemetry: Layer.Layer<never, never, Settings> = Layer.unwrap(
  Settings.pipe(
    Effect.map((config) => {
      // Identity, not decoration: several dispatchers can report to one gateway,
      // and a span nobody can attribute to a machine and a run answers none of
      // the questions the history exists for.
      const resource = {
        serviceName: "foreman",
        serviceVersion: VERSION,
        attributes: { "service.instance.id": `${hostname()}:${process.pid}` },
      };
      return Layer.mergeAll(
        OtlpTracer.layer({ url: `${config.otlpEndpoint}/v1/traces`, resource }),
        OtlpMetrics.layer({ url: `${config.otlpEndpoint}/v1/metrics`, resource }),
      );
    }),
  ),
).pipe(
  // JSON rather than protobuf: a collector accepts both, and this path needs no
  // encoder beyond what Effect already ships. Bun's global fetch is the client.
  Layer.provide(OtlpSerialization.layerJson),
  Layer.provide(FetchHttpClient.layer),
);
