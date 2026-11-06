// is mekiki able to review? the database answers and at least one agent is ready: a cli installed
// and logged in, or the api agent with its key. /api/health says so (docker's healthcheck and uptime
// monitors read it), and a monitor logs an error the moment an agent stops working: a cli login
// expires quietly otherwise
import { Context, Duration, Effect, Layer, Option, Ref, Schedule } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { Agent } from "./agent.ts"
import type { AgentKind } from "./domain.ts"
import { Store } from "./store.ts"

/** the version each cli reports (the api agent: its provider and model), or null when it can't review */
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

export class Service extends Context.Service<Service, Interface>()("mekiki/Health") {}

/** what's wrong, in the log */
const DOWN: Record<AgentKind, string> = {
  claude: "claude isn't installed or logged in: reviews with it fail until it is",
  codex: "codex isn't installed or logged in: reviews with it fail until it is",
  api: "the api agent has no provider, model or key: reviews with it fail until it does",
}

export const make = Effect.gen(function* () {
  const agent = yield* Agent.Service
  const store = yield* Store.Service
  const KINDS = agent.offered

  const lookUp = Effect.all(
    {
      claude: agent.check("claude").pipe(Effect.option, Effect.map(Option.getOrNull)),
      codex: agent.check("codex").pipe(Effect.option, Effect.map(Option.getOrNull)),
      api: agent.check("api").pipe(Effect.option, Effect.map(Option.getOrNull)),
    },
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
  const previous = yield* Ref.make<Agents | undefined>(undefined)
  const monitor = Effect.gen(function* () {
    const now = yield* lookUp
    const last = yield* Ref.getAndSet(previous, now)
    yield* Effect.forEach(KINDS, (kind) => {
      const was = last?.[kind]
      // the api agent is opt in: one never set up isn't a problem
      if (kind === "api" && now.api === null && (last === undefined || was === null)) return Effect.void
      if (now[kind] === null && (last === undefined || was !== null)) return Effect.logError(DOWN[kind])
      if (now[kind] !== null && last !== undefined && was === null) return Effect.logInfo(`${kind} works again (${now[kind]})`)
      if (now[kind] !== null && last === undefined) return Effect.logInfo(`${kind}: ${now[kind]}`)
      return Effect.void
    })
  }).pipe(Effect.repeat(Schedule.spaced(Duration.minutes(5))))
  yield* Effect.forkScoped(monitor)

  return Service.of({ agents, report })
})

export const layer = Layer.effect(Service, make)

/** GET /api/health: 200 when mekiki can review, 503 and what's wrong otherwise */
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
