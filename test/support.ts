// what the tests share: config from an env record, and stand-ins for the services that reach out
// (github, the agent clis, the review pipeline), each recording what it was asked
import { PgliteClient } from "@effect/sql-pglite"
import * as PgliteDrizzle from "drizzle-orm/effect-pglite"
import { migrate } from "drizzle-orm/effect-pglite/migrator"
import { ConfigProvider, Effect, Layer, Option, PubSub, Stream } from "effect"
import { Agent } from "../src/agent.ts"
import { Auth } from "../src/auth.ts"
import { Checkout } from "../src/checkout.ts"
import { AppConfig } from "../src/config.ts"
import { Database } from "../src/database.ts"
import { GitHubError, type PrRef, type Review } from "../src/domain.ts"
import { GitHub, type Permission } from "../src/github.ts"
import { Health } from "../src/health.ts"
import { Panel } from "../src/panel.ts"
import { Reviewer, type StartOptions } from "../src/reviewer.ts"
import { Store } from "../src/store.ts"
import { Usage } from "../src/usage.ts"

export const configFrom = (env: Record<string, string>) =>
  Effect.runSync(
    Effect.gen(function* () {
      return yield* AppConfig
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))),
  )

export const review = (overrides: Partial<Review> = {}): Omit<Review, "id"> => ({
  repo: "o/r",
  number: 1,
  title: "t",
  url: "https://github.com/o/r/pull/1",
  headSha: "abc",
  agent: "claude",
  model: "",
  depth: "light",
  status: "done",
  trigger: "manual",
  dryRun: false,
  incremental: false,
  posted: false,
  files: 1,
  skippedFiles: 0,
  chunks: 1,
  startedAt: Date.now(),
  durationMs: 1000,
  summary: "",
  findings: [],
  unreviewed: [],
  steps: [],
  error: null,
  usage: null,
  ...overrides,
})

/** what the fake reviewer was asked to do */
export interface Calls {
  readonly started: Array<{ readonly pr: PrRef; readonly options: StartOptions }>
  readonly cancelled: Array<PrRef>
}

export const fakeReviewer = (calls: Calls) =>
  Layer.effect(
    Reviewer.Service,
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<Review>()
      return Reviewer.Service.of({
        start: (pr, options) => Effect.sync(() => void calls.started.push({ pr, options })),
        run: () => Effect.die("not in tests"),
        cancel: (pr) => Effect.sync(() => void calls.cancelled.push(pr)),
        subscribe: PubSub.subscribe(changes),
      })
    }),
  )

export const fakeAgent = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    check: (agent) => Effect.succeed(`${agent} 1.0`),
    models: (agent) =>
      Effect.succeed(
        agent === "claude"
          ? [
              { id: "", label: "Default" },
              { id: "sonnet", label: "Sonnet" },
            ]
          : agent === "api"
            ? [
                { id: "", label: "Default (gpt-6-sol)" },
                { id: "gpt-6-luna", label: "gpt-6-luna" },
              ]
            : [{ id: "", label: "Default" }],
      ),
    review: () => Effect.die("not in tests"),
  }),
)

/** signing in, faked: a request carrying `cookie: signed-in` is alice, any other is nobody. off: everyone is the local user */
export const fakeAuth = (enabled: boolean) =>
  Layer.succeed(
    Auth.Service,
    Auth.Service.of({
      enabled,
      methods: { github: enabled, sso: null },
      handler: () => Effect.succeed(new Response(null, { status: 404 })),
      user: (headers) =>
        Effect.succeed(
          !enabled
            ? Option.some(Auth.LOCAL)
            : headers.get("cookie") === "signed-in"
              ? Option.some({ id: "u1", name: "Alice", email: "alice@acme.com", image: null })
              : Option.none(),
        ),
      instance: null,
    }),
  )

export const fakeHealth = Layer.succeed(
  Health.Service,
  Health.Service.of({
    agents: Effect.succeed({ claude: "claude 1.0", codex: null, api: null }),
    report: Effect.succeed({ ok: true, database: "ok", agents: { claude: "claude 1.0", codex: null, api: null } }),
  }),
)

/** subscription usage, faked: never checked */
const unchecked = { windows: [], checkedAt: 0, unavailable: "not checked in tests" }
export const fakeUsage = Layer.succeed(Usage.Service, Usage.Service.of({ read: Effect.succeed({ claude: unchecked, codex: unchecked }) }))

/**
 * github, faked: `permissions` is who has what on every repository (everyone else: none). no review
 * threads; `resolved` records each thread resolved, with its reply. installed on acme/api and acme/web
 */
export const fakeGitHub = (
  acknowledged: Array<number>,
  permissions: Record<string, Permission> = {},
  resolved: Array<{ readonly id: string; readonly reply: string }> = [],
) =>
  Layer.succeed(
    GitHub.Service,
    GitHub.Service.of({
      pullRequest: () => Effect.fail(new GitHubError({ operation: "pullRequest", message: "not in tests" })),
      diff: () => Effect.succeed(""),
      compare: () => Effect.succeed(""),
      postReview: () => Effect.void,
      gitRemote: () => Effect.fail(new GitHubError({ operation: "auth", message: "not in tests" })),
      tarball: () => Stream.empty,
      createComment: () => Effect.succeed(1),
      updateComment: () => Effect.void,
      acknowledge: (_, id) => Effect.sync(() => void acknowledged.push(id)),
      permission: (_, login) => Effect.succeed(permissions[login] ?? "none"),
      reviewThreads: () => Effect.succeed([]),
      resolveThread: (_, id, reply) => Effect.sync(() => void resolved.push({ id, reply })),
      collapseThread: (_, id, _comment, reply) => Effect.sync(() => void resolved.push({ id, reply })),
      repositories: Effect.succeed(["acme/api", "acme/web"]),
    }),
  )

export const fakePanel = (shown: Array<{ readonly pr: PrRef; readonly kind: string }>) =>
  Layer.succeed(Panel.Service, Panel.Service.of({ show: (pr, state) => Effect.sync(() => void shown.push({ pr, kind: state.kind })) }))

export const fakeCheckout = Layer.succeed(Checkout.Service, Checkout.Service.of({ at: () => Effect.succeed("/tmp/nowhere") }))

/** a fresh postgres for each layer built, in-process (pglite): the real migrations and the real queries */
export const memoryDatabase = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const db = yield* PgliteDrizzle.makeWithDefaults()
    yield* migrate(db, { migrationsFolder: Database.MIGRATIONS })
    return db
  }),
).pipe(Layer.provide(PgliteClient.layer()), Layer.orDie)

export const memoryStore = (config: AppConfig) => Store.layer({ defaults: config.defaults }).pipe(Layer.provide(memoryDatabase))
