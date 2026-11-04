// logs: json lines in production (MEKIKI_LOG_FORMAT=json, set by the docker image) for a log
// collector, pretty while developing. with MEKIKI_OTLP_URL, traces and logs go to an otlp collector too
import { Layer, Logger, Option, References } from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp } from "effect/observability"
import type { AppConfig } from "./config.ts"

export const layer = (config: AppConfig["observability"]) => {
  const logs = Logger.layer([config.logFormat === "json" ? Logger.consoleJson : Logger.consolePretty()])
  const level = Layer.succeed(References.MinimumLogLevel, config.logLevel)
  const otlp = Option.match(config.otlpUrl, {
    onNone: () => Layer.empty,
    onSome: (baseUrl) =>
      Otlp.layerJson({ baseUrl, resource: { serviceName: "mekiki" }, loggerMergeWithExisting: true }).pipe(Layer.provide(FetchHttpClient.layer)),
  })
  return Layer.mergeAll(logs, level, otlp)
}

export * as Observability from "./observability.ts"
