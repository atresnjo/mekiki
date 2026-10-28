// Account-wide subscription limits. Reads never run a model or spend credits; failures are safe UI states.
import { homedir } from "node:os"
import { join } from "node:path"
import { Clock, Context, Duration, Effect, Exit, FileSystem, Layer, Option, Queue, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { agentEnv, childEnv, type Options } from "./agent.ts"
import type { SubscriptionUsage, UsageWindow } from "./rpc.ts"

class Unavailable extends Schema.TaggedError<Unavailable>()("UsageUnavailable", {
  message: Schema.String,
  /** milliseconds the provider asked us to wait before checking again */
  retryAfter: Schema.optional(Schema.Finite),
}) {}
const unavailable = (message: string) => new Unavailable({ message })
// Claude's usage endpoint shares a small rate-limit budget with the user's own /usage, so it is checked rarely.
const CLAUDE_EVERY = Duration.minutes(15)
const CODEX_EVERY = Duration.minutes(5)
// Retry-After is seconds or an HTTP date. Missing or unparsable falls back; an absurd value is capped so checks resume.
const retryAfter = (header: string | undefined, now: number) => {
  const millis = header && /^\d+$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header ?? "") - now
  return Number.isFinite(millis) && millis > 0 ? Math.min(millis, Duration.toMillis(Duration.hours(6))) : Duration.toMillis(Duration.minutes(30))
}
const inWords = (millis: number) => {
  const minutes = Math.max(1, Math.ceil(millis / 60_000))
  return minutes < 90 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(minutes / 60)} hours`
}
const Percent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
const ClaudeWindow = Schema.Struct({ utilization: Percent, resets_at: Schema.NullOr(Schema.String) })
const ClaudeUsage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(ClaudeWindow)),
  seven_day: Schema.optional(Schema.NullOr(ClaudeWindow)),
  seven_day_sonnet: Schema.optional(Schema.NullOr(ClaudeWindow)),
  seven_day_opus: Schema.optional(Schema.NullOr(ClaudeWindow)),
})
const Credentials = Schema.Struct({ claudeAiOauth: Schema.Struct({ accessToken: Schema.String }) })
const CodexWindow = Schema.Struct({
  usedPercent: Percent,
  windowDurationMins: Schema.optional(Schema.NullOr(Schema.Finite)),
  resetsAt: Schema.optional(Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000 })))),
})
const CodexBucket = Schema.Struct({
  limitName: Schema.optional(Schema.NullOr(Schema.String)),
  primary: Schema.optional(Schema.NullOr(CodexWindow)),
  secondary: Schema.optional(Schema.NullOr(CodexWindow)),
})
const CodexUsage = Schema.Struct({
  rateLimits: CodexBucket,
  rateLimitsByLimitId: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, CodexBucket))),
})
const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
})

export class Service extends Context.Service<Service, { readonly read: Effect.Effect<SubscriptionUsage> }>()("glance/Usage") {}

export const make = Effect.fn("Usage.make")(function* (options: Pick<Options, "codexBin">) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  // No redirects: a provider must never forward an OAuth token to another host.
  const client = yield* HttpClient.HttpClient

  const claudeToken = Effect.gen(function* () {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
    const text = yield* (
      process.platform === "darwin" && !process.env.CLAUDE_CONFIG_DIR
        ? spawner.string(ChildProcess.make("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { env: childEnv(), stderr: "ignore" }))
        : fs.readFileString(join(configDir, ".credentials.json"))
    ).pipe(Effect.mapError(() => unavailable("Claude login unavailable. Sign in to Claude Code on the server.")))
    const credentials = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Credentials))(text).pipe(
      Effect.mapError(() => unavailable("Claude login unreadable. Sign in to Claude Code again.")),
    )
    return credentials.claudeAiOauth.accessToken
  })

  const claude = Effect.gen(function* () {
    const token = yield* claudeToken
    const response = yield* client
      .execute(
        HttpClientRequest.get("https://api.anthropic.com/api/oauth/usage").pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader("anthropic-beta", "oauth-2025-04-20"),
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.mapError(() => unavailable("Could not reach Claude usage. Try again later.")),
      )
    if (response.status === 401) return yield* unavailable("Claude login expired. Sign in to Claude Code again.")
    if (response.status === 403) return yield* unavailable("This Claude login cannot read usage. Check /usage in Claude Code.")
    if (response.status === 429)
      return yield* new Unavailable({
        message: "Claude is rate limiting usage checks.",
        retryAfter: retryAfter(response.headers["retry-after"], yield* Clock.currentTimeMillis),
      })
    if (response.status !== 200) return yield* unavailable("Claude usage is temporarily unavailable. Try again later.")
    const data = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ClaudeUsage)),
      Effect.mapError(() => unavailable("Claude returned unrecognized usage data. Check /usage in Claude Code.")),
    )
    const entries = [
      ["5-hour", data.five_hour],
      ["Weekly", data.seven_day],
      ["Weekly · Sonnet", data.seven_day_sonnet],
      ["Weekly · Opus", data.seven_day_opus],
    ] as const
    return entries.flatMap(([label, window]): Array<UsageWindow> => {
      if (!window) return []
      const reset = window.resets_at === null ? NaN : Date.parse(window.resets_at)
      return [{ label, usedPercent: window.utilization, resetsAt: Number.isFinite(reset) ? reset : null }]
    })
  })

  const codex = Effect.gen(function* () {
    // A short-lived app-server owns login refresh; no auth.json parsing and no model turn.
    const input = yield* Queue.unbounded<string>()
    yield* Queue.offer(input, JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "glance_usage", version: "1.0" } } }) + "\n")
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "glance-usage-" })
    const child = yield* spawner.spawn(
      ChildProcess.make(options.codexBin, ["app-server"], {
        cwd: dir,
        env: agentEnv(),
        stderr: "ignore",
        stdin: Stream.fromQueue(input).pipe(Stream.encodeText),
      }),
    )
    const result = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapEffect((line) => Schema.decodeUnknownEffect(Schema.fromJsonString(Message))(line)),
      Stream.tap((message) =>
        message.id === 1 && message.error === undefined
          ? Queue.offerAll(input, [JSON.stringify({ method: "initialized" }) + "\n", JSON.stringify({ id: 2, method: "account/rateLimits/read" }) + "\n"])
          : Effect.void,
      ),
      Stream.filter((message) => message.id === 2 || (message.id === 1 && message.error !== undefined)),
      Stream.runHead,
    )
    if (Option.isNone(result) || result.value.error !== undefined)
      return yield* unavailable("Codex usage unavailable. Check your subscription login with codex login status.")
    const data = yield* Schema.decodeUnknownEffect(CodexUsage)(result.value.result)
    const buckets =
      data.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length > 0
        ? Object.entries(data.rateLimitsByLimitId)
        : [["codex", data.rateLimits] as const]
    return buckets.flatMap(([id, bucket]) =>
      [bucket.primary, bucket.secondary].flatMap((window, index): Array<UsageWindow> => {
        if (!window) return []
        const minutes = window.windowDurationMins
        const duration =
          minutes === 10080
            ? "Weekly"
            : minutes && minutes % 60 === 0
              ? `${minutes / 60}-hour`
              : minutes
                ? `${minutes}-minute`
                : index === 0
                  ? "Primary"
                  : "Secondary"
        return [
          {
            label: id === "codex" ? duration : `${bucket.limitName || id} · ${duration}`,
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt == null ? null : window.resetsAt * 1000,
          },
        ]
      }),
    )
  }).pipe(Effect.mapError(() => unavailable("Codex usage unavailable. Check your subscription login with codex login status.")))

  const snapshot = <E, R>(effect: Effect.Effect<ReadonlyArray<UsageWindow>, E, R>) =>
    effect.pipe(
      Effect.timeout("12 seconds"),
      Effect.scoped,
      Effect.map((windows) => ({
        windows,
        unavailable: windows.length ? null : "The provider did not report subscription limits.",
        retryAfter: undefined,
      })),
      Effect.catch((error) =>
        Effect.succeed({
          windows: [],
          unavailable: error instanceof Unavailable ? error.message : "Usage check timed out or failed. Try again later.",
          retryAfter: error instanceof Unavailable ? error.retryAfter : undefined,
        }),
      ),
      Effect.flatMap(({ retryAfter, ...usage }) => Effect.map(Clock.currentTimeMillis, (checkedAt) => ({ usage: { ...usage, checkedAt }, retryAfter }))),
    )
  // Cache failures too, per provider. Refreshing a dashboard must not hammer either one, and a rate limit waits out its Retry-After.
  const poll = Effect.fnUntraced(function* <E, R>(effect: Effect.Effect<ReadonlyArray<UsageWindow>, E, R>, every: Duration.Duration) {
    const wait = (retryAfter: number | undefined) => Math.max(Duration.toMillis(every), retryAfter ?? 0)
    const cached = yield* Effect.cachedWithTTL(snapshot(effect), (exit) => (Exit.isSuccess(exit) ? wait(exit.value.retryAfter) : every))
    return Effect.gen(function* () {
      const { usage, retryAfter } = yield* cached
      if (retryAfter === undefined) return usage
      const next = usage.checkedAt + wait(retryAfter) - (yield* Clock.currentTimeMillis)
      return { ...usage, unavailable: `${usage.unavailable} Next check in ${inWords(next)}.` }
    })
  })
  const claudeUsage = yield* poll(claude, CLAUDE_EVERY)
  const codexUsage = yield* poll(codex, CODEX_EVERY)
  const read: Effect.Effect<SubscriptionUsage> = Effect.all({ claude: claudeUsage, codex: codexUsage }, { concurrency: "unbounded" })
  return Service.of({ read })
})

export const layer = (options: Pick<Options, "codexBin">) => Layer.effect(Service, make(options)).pipe(Layer.provide(FetchHttpClient.layer))
export * as Usage from "./usage.ts"
