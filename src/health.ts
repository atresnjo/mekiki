// is glance able to review? the database answers and at least one agent cli is installed and
// logged in. /api/health says so (docker's healthcheck and uptime monitors read it), and a
// monitor logs an error the moment an agent stops working: a cli login expires quietly otherwise
import { Context, Duration, Effect, Layer, Option, Schedule } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { Agent } from "./agent.ts"
import type { AgentKind } from "./domain.ts"
import { Store } from "./store.ts"

/** the version each cli reports, or null when it isn't installed or isn't logged in */
export type Agents = Record<AgentKind, string | null>

export interface Report {
  readonly ok: boolean
  readonly database: string
  readonly agents: Agents
}

export interface Interface {
  /** looked up at most once a minute: a check costs a process spawn per cli */
  readonly agents: Effect.Effect<Agents>
  readonly report: Effect.Effect<Report>
}

export class Service extends Context.Service<Service, Interface>()("glance/Health") {}

const KINDS: ReadonlyArray<AgentKind> = ["claude", "codex"]

export const make = Effect.gen(function* () {
  const agent = yield* Agent.Service
  const store = yield* Store.Service

  const lookUp = Effect.all(
    Object.fromEntries(KINDS.map((kind) => [kind, agent.check(kind).pipe(Effect.option, Effect.map(Option.getOrNull))])) as Record<
      AgentKind,
      Effect.Effect<string | null>
    >,
    { concurrency: "unbounded" },
  )
  const agents = yield* Effect.cachedWithTTL(lookUp, Duration.minutes(1))

  const report = Effect.gen(function* () {
    const [database, found] = yield* Effect.all(
      [
        store.ping.pipe(
          Effect.as("ok"),
          Effect.catch((e) => Effect.succeed(e.message)),
        ),
        agents,
      ],
      { concurrency: "unbounded" },
    )
    return { ok: database === "ok" && KINDS.some((k) => found[k] !== null), database, agents: found }
  })

  // every few minutes, fresh: say when an agent stops working, and when it's back
  let last: Agents | undefined
  const monitor = lookUp.pipe(
    Effect.tap((now) =>
      Effect.forEach(KINDS, (kind) => {
        const was = last?.[kind]
        if (now[kind] === null && (last === undefined || was !== null))
          return Effect.logError(`${kind} isn't installed or logged in: reviews with it fail until it is`)
        if (now[kind] !== null && last !== undefined && was === null) return Effect.logInfo(`${kind} works again (${now[kind]})`)
        if (now[kind] !== null && last === undefined) return Effect.logInfo(`${kind}: ${now[kind]}`)
        return Effect.void
      }),
    ),
    Effect.tap((now) => Effect.sync(() => (last = now))),
    Effect.repeat(Schedule.spaced(Duration.minutes(5))),
  )
  yield* Effect.forkScoped(monitor)

  return Service.of({ agents, report })
})

export const layer = Layer.effect(Service, make)

/** GET /api/health: 200 when glance can review, 503 and what's wrong otherwise */
export const routes = Layer.unwrap(
  Effect.gen(function* () {
    const health = yield* Service
    return HttpRouter.add(
      "GET",
      "/api/health",
      Effect.map(health.report, (report) => HttpServerResponse.jsonUnsafe(report, { status: report.ok ? 200 : 503 })),
    )
  }),
)

export * as Health from "./health.ts"
