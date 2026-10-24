// the rpc api (rpc.ts) on top of glance's services, served at RPC_PATH (http + ndjson).
// every call is checked by the Authenticated middleware: better auth's session, and whether they're still allowed in
import { Duration, Effect, Layer, Option, Stream } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { Agent } from "./agent.ts"
import { Auth } from "./auth.ts"
import type { AppConfig } from "./config.ts"
import { type Depth, parsePrUrl, type Review } from "./domain.ts"
import { Health } from "./health.ts"
import { Reviewer } from "./reviewer.ts"
import { Authenticated, CurrentUser, Failed, GlanceRpcs, HEARTBEAT, Invalid, NotFound, PAGE, RPC_PATH, ReviewsEvent, Unauthorized } from "./rpc.ts"
import { Store } from "./store.ts"

const depthOverride = (depth: Depth | undefined) => (depth ? { depth } : {})

/** what started a review, and who: "manual by alice@acme.com" */
const by = (trigger: string) => Effect.map(CurrentUser, (user) => (user.email ? `${trigger} by ${user.email}` : trigger))

const prOf = (review: Review) => {
  const [owner = "", repo = ""] = review.repo.split("/")
  return { owner, repo, number: review.number }
}

/** Expected refusals stay typed; infrastructure failures and defects are logged and sanitized. */
const failed = (defect: unknown) =>
  Effect.logError("rpc failed", defect).pipe(Effect.andThen(Effect.fail(new Failed({ message: "glance failed: the details are in its log" }))))
const api = <A, E, R>(effect: Effect.Effect<A, E | Store.StoreError, R>) => effect.pipe(Effect.catchTag("StoreError", failed), Effect.catchDefect(failed))

export const AuthenticatedLive = Layer.effect(
  Authenticated,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    return Authenticated.of(
      Effect.fn("Rpc.authenticate")(function* (effect, { headers }) {
        const user = yield* auth.user(Auth.webHeaders(headers))
        if (Option.isNone(user)) return yield* new Unauthorized({ message: "sign in to use glance" })
        return yield* Effect.provideService(effect, CurrentUser, user.value)
      }),
    )
  }),
)

export const HandlersLive = (config: AppConfig) =>
  GlanceRpcs.toLayer(
    Effect.gen(function* () {
      const reviewer = yield* Reviewer.Service
      const store = yield* Store.Service
      const agent = yield* Agent.Service
      const health = yield* Health.Service
      const auth = yield* Auth.Service

      const reviewById = Effect.fn("Rpc.reviewById")(function* (id: number) {
        const review = yield* store.get(id)
        if (Option.isNone(review)) return yield* new NotFound({ message: `no review ${id}` })
        return review.value
      })

      // the model lists cost a process spawn, and change only with a cli update
      const models = yield* Effect.cachedWithTTL(
        Effect.all(
          {
            claude: agent.models("claude").pipe(Effect.orElseSucceed(() => [{ id: "", label: "Default" }])),
            codex: agent.models("codex").pipe(Effect.orElseSucceed(() => [{ id: "", label: "Default" }])),
          },
          { concurrency: "unbounded" },
        ),
        Duration.minutes(10),
      )

      return GlanceRpcs.of({
        WatchReviews: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              // subscribe before reading the list, so a change in between isn't lost
              const changes = yield* reviewer.subscribe
              const reviews = yield* store.list(PAGE)
              const heartbeats = Stream.tick(HEARTBEAT).pipe(Stream.map(() => ReviewsEvent.cases.Heartbeat.make({})))
              return Stream.succeed(ReviewsEvent.cases.Snapshot.make({ reviews })).pipe(
                Stream.concat(Stream.fromSubscription(changes).pipe(Stream.map((review) => ReviewsEvent.cases.Changed.make({ review })))),
                Stream.merge(heartbeats),
              )
            }),
          ).pipe(
            Stream.catchTag("StoreError", (error) => Stream.fromEffect(failed(error))),
            Stream.catchDefect((defect) => Stream.fromEffect(failed(defect))),
          ),

        ListReviews: ({ before }) => store.listBefore(before, PAGE).pipe(api),

        StartReview: Effect.fn("Rpc.StartReview")(function* ({ url, dryRun, depth }) {
          const ref = parsePrUrl(url)
          if (!ref) return yield* new Invalid({ message: "expected a pull request url like https://github.com/owner/repo/pull/123" })
          yield* reviewer.start(ref, { trigger: yield* by("manual"), dryRun, overrides: depthOverride(depth) })
        }, api),

        RetryReview: Effect.fn("Rpc.RetryReview")(function* ({ id, depth }) {
          const review = yield* reviewById(id)
          yield* reviewer.start(prOf(review), { trigger: yield* by(depth ? `retry ${depth}` : "retry"), overrides: depthOverride(depth) })
        }, api),

        CancelReview: Effect.fn("Rpc.CancelReview")(function* ({ id }) {
          const review = yield* reviewById(id)
          yield* Effect.logInfo(`${yield* by("cancelled")} ${review.repo}#${review.number}`)
          yield* reviewer.cancel(prOf(review))
        }, api),

        GetStatus: Effect.fn("Rpc.GetStatus")(function* () {
          const agents = yield* health.agents
          return { agents, webhook: Option.isSome(config.github.webhookSecret), auth: auth.enabled, user: yield* CurrentUser }
        }, api),

        GetSettings: () => store.settings.pipe(api),

        GetModels: () => models.pipe(api),

        SaveSettings: Effect.fn("Rpc.SaveSettings")(function* (settings) {
          const offered = yield* models
          if (!offered[settings.agent].some((model) => model.id === settings.model))
            return yield* new Invalid({ message: `${settings.agent} has no model "${settings.model}"` })
          return yield* store.saveSettings(settings)
        }, api),
      })
    }),
  )

/** POST RPC_PATH: the handlers, the auth middleware, ndjson so the review stream works over plain http */
export const routes = (config: AppConfig) =>
  RpcServer.layerHttp({ group: GlanceRpcs, path: RPC_PATH, protocol: "http" }).pipe(
    Layer.provide(HandlersLive(config)),
    Layer.provide(AuthenticatedLive),
    Layer.provide(RpcSerialization.layerNdjson),
  )
