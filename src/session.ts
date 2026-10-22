// signing in to the dashboard. the access token is exchanged once for a session cookie (http-only,
// so scripts on the page can't read it), which every rpc call then carries. the cookie is an
// expiry signed with the token: nothing about sessions is stored, and rotating the token signs
// everyone out. sign-in attempts are limited per client, so the token can't be guessed by brute force
import { createHmac, timingSafeEqual } from "node:crypto"
import { Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FileSystem } from "effect"
import { Cookies, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { RateLimiter } from "effect/persistence"
import { type AppConfig, authEnabled } from "./config.ts"

export const COOKIE = "glance_session"

/** sign-in attempts per client in WINDOW */
const ATTEMPTS = 10
const WINDOW = Duration.minutes(15)

export class SignInRefused extends Schema.TaggedError<SignInRefused>()("SignInRefused", {
  message: Schema.String,
  /** too many attempts: when the next one is allowed */
  retryAfter: Schema.optional(Schema.Finite),
}) {}

export interface Interface {
  /** a token is configured: the dashboard needs signing in */
  readonly enabled: boolean
  /** the cookie value for a correct token */
  readonly signIn: (token: string, client: string) => Effect.Effect<string, SignInRefused>
  /** the cookie is ours, signed with the current token and not expired. always true when signing in is off */
  readonly verify: (cookie: string | undefined) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("glance/Session") {}

/** constant time, for secrets */
export const equal = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const signature = (token: string, expires: number) => createHmac("sha256", token).update(`glance-session:${expires}`).digest("base64url")

export const sign = (token: string, expires: number) => `${expires}.${signature(token, expires)}`

export const check = (token: string, cookie: string, now: number) => {
  const [expires = "", mac = ""] = cookie.split(".")
  const at = Number(expires)
  return Number.isSafeInteger(at) && at > now && equal(mac, signature(token, at))
}

export const make = Effect.fn("Session.make")(function* (config: AppConfig) {
  const fs = yield* FileSystem.FileSystem
  const limiter = yield* RateLimiter.RateLimiter
  const lifetime = Duration.toMillis(Duration.days(config.auth.sessionDays))

  // the file wins, read again every half minute: rotating the token needs no restart. a file that
  // can't be read refuses everyone rather than letting everyone in
  const token: Effect.Effect<Option.Option<string>> = Option.isSome(config.auth.tokenFile)
    ? yield* Effect.cachedWithTTL(
        fs.readFileString(config.auth.tokenFile.value).pipe(
          Effect.map((text) => Option.some(text.trim()).pipe(Option.filter((t) => t.length > 0))),
          Effect.tapError((e) => Effect.logError("couldn't read GLANCE_TOKEN_FILE: signing in is refused", e)),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
        Duration.seconds(30),
      )
    : Effect.succeed(Option.map(config.auth.token, Redacted.value))

  const enabled = authEnabled(config)

  const signIn = Effect.fn("Session.signIn")(function* (attempt: string, client: string) {
    yield* limiter.consume({ key: `sign-in:${client}`, limit: ATTEMPTS, window: WINDOW }).pipe(
      Effect.catchTag("RateLimiterError", (e) =>
        Effect.fail(
          new SignInRefused({
            message: "too many sign-in attempts: try again later",
            retryAfter: e.reason._tag === "RateLimitExceeded" ? Math.ceil(Duration.toSeconds(e.reason.retryAfter)) : undefined,
          }),
        ),
      ),
    )
    const current = yield* token
    if (Option.isNone(current) || !equal(attempt, current.value)) return yield* new SignInRefused({ message: "that's not the access token" })
    return sign(current.value, Date.now() + lifetime)
  })

  const verify = (cookie: string | undefined) =>
    enabled ? Effect.map(token, (current) => cookie !== undefined && Option.isSome(current) && check(current.value, cookie, Date.now())) : Effect.succeed(true)

  return Service.of({ enabled, signIn, verify })
})

export const layer = (config: AppConfig) =>
  Layer.effect(Service, make(config)).pipe(Layer.provide(RateLimiter.layer), Layer.provide(RateLimiter.layerStoreMemory))

// ---------- http: POST /api/session signs in, DELETE signs out ----------

const SignInBody = Schema.Struct({ token: Schema.String })

/** who's asking, for limiting attempts: the proxy's word for it when there's a trusted proxy in front */
export const clientOf = (request: HttpServerRequest.HttpServerRequest, trustProxy: boolean) =>
  (trustProxy ? request.headers["x-forwarded-for"]?.split(",")[0]?.trim() : undefined) || Option.getOrElse(request.remoteAddress, () => "unknown")

export const routes = (config: AppConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sessions = yield* Service
      const lifetime = Duration.days(config.auth.sessionDays)
      // https as the browser sees it: the proxy terminates tls in front of glance
      const secure = (request: HttpServerRequest.HttpServerRequest) => config.auth.trustProxy && request.headers["x-forwarded-proto"] === "https"
      const cookie = (request: HttpServerRequest.HttpServerRequest): NonNullable<Cookies.Cookie["options"]> => ({
        httpOnly: true,
        sameSite: "strict",
        path: "/api",
        secure: secure(request),
      })

      const signIn = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* HttpServerRequest.schemaBodyJson(SignInBody).pipe(Effect.option)
        if (Option.isNone(body)) return HttpServerResponse.jsonUnsafe({ error: "expected { token }" }, { status: 400 })
        const value = yield* sessions.signIn(body.value.token, clientOf(request, config.auth.trustProxy)).pipe(Effect.result)
        if (value._tag === "Failure") {
          const { message, retryAfter } = value.failure
          return retryAfter === undefined
            ? HttpServerResponse.jsonUnsafe({ error: message }, { status: 401 })
            : HttpServerResponse.jsonUnsafe({ error: message }, { status: 429, headers: { "Retry-After": String(retryAfter) } })
        }
        return yield* HttpServerResponse.empty({ status: 204 }).pipe(
          HttpServerResponse.setCookie(COOKIE, value.success, { ...cookie(request), maxAge: lifetime }),
        )
      }).pipe(Effect.orDie)

      const signOut = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* HttpServerResponse.empty({ status: 204 }).pipe(HttpServerResponse.setCookie(COOKIE, "", { ...cookie(request), maxAge: 0 }))
      }).pipe(Effect.orDie)

      return HttpRouter.addAll([HttpRouter.route("POST", "/api/session", signIn), HttpRouter.route("DELETE", "/api/session", signOut)])
    }),
  )

export * as Session from "./session.ts"
