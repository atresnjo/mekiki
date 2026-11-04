import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { Checkout } from "../../src/checkout.ts"
import { Agent } from "../../src/agent.ts"
import { Auth } from "../../src/auth.ts"
import { GitHub } from "../../src/github.ts"
import { Panel } from "../../src/panel.ts"
import { Reviewer } from "../../src/reviewer.ts"
import { Usage } from "../../src/usage.ts"
import { Store } from "../../src/store.ts"
import { Triggers } from "../../src/triggers.ts"
import * as Rpc from "../../src/rpc-server.ts"
import * as Http from "../../src/http.ts"
import type { SubscriptionUsage } from "../../src/rpc.ts"
import { configFrom, fakeGitHub, fakeHealth, memoryStore } from "../support.ts"
import { resolve } from "node:path"

const config = configFrom({
  GITHUB_WEBHOOK_SECRET: "e2e-webhook",
  CLAUDE_BIN: resolve("test/e2e/agent.ts"),
  CODEX_BIN: resolve("test/e2e/agent.ts"),
})
// Signing in goes through GitHub or SSO, so the browser holds this cookie instead of a real session.
const SignedIn = Layer.succeed(
  Auth.Service,
  Auth.Service.of({
    enabled: true,
    methods: { github: true, sso: null },
    handler: () => Effect.succeed(new Response(null, { status: 404 })),
    user: (headers) =>
      Effect.succeed(
        (headers.get("cookie") ?? "").split(/;\s*/).includes("mekiki-e2e=signed-in")
          ? Option.some({ id: "e2e", name: "E2E", email: "e2e@acme.com", image: null })
          : Option.none(),
      ),
    instance: null,
  }),
)
const counts = { posts: 0, panels: 0, usage: 0 }
let mode = "ok"
// The usage service built by the last /_mode, so a later /_usage reads through its cache.
let probe: Effect.Effect<SubscriptionUsage> = Effect.die("set a mode first")
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => {
    counts.usage++
    if (mode === "rate-limited") return new Response("private upstream diagnostic", { status: 429, headers: { "retry-after": "1708" } })
    if (mode === "forbidden") return new Response("private upstream diagnostic", { status: 403 })
    if (mode === "expired") return new Response("private upstream diagnostic", { status: 401 })
    if (mode === "malformed") return Response.json({ five_hour: { utilization: "bad", resets_at: null } })
    return Response.json({
      five_hour: { utilization: 42, resets_at: "2030-01-01T00:00:00Z" },
      seven_day: { utilization: 76.5, resets_at: "2030-01-05T00:00:00Z" },
    })
  },
})
const providerClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    client.pipe(HttpClient.mapRequest((request) => HttpClientRequest.setUrl(request, `http://127.0.0.1:${provider.port}/usage`))),
  ),
).pipe(Layer.provide(FetchHttpClient.layer))
const UsageLive = Layer.effect(Usage.Service, Usage.make(config.agent)).pipe(Layer.provide(providerClient))
const Github = Layer.effect(
  GitHub.Service,
  Effect.map(GitHub.Service, (base) =>
    GitHub.Service.of({
      ...base,
      pullRequest: (ref) =>
        Effect.succeed({
          title: "End-to-end dry run",
          body: "",
          state: "open",
          html_url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
          head: { sha: "abc" },
        }),
      diff: () => Effect.succeed("diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n"),
      postReview: () =>
        Effect.sync(() => {
          counts.posts++
        }),
      createComment: () =>
        Effect.sync(() => {
          counts.panels++
          return 77
        }),
      updateComment: () =>
        Effect.sync(() => {
          counts.panels++
        }),
    }),
  ),
).pipe(Layer.provide(fakeGitHub([], { writer: "write" })))
const Adapters = Layer.mergeAll(
  memoryStore(config),
  Agent.layer(config.agent),
  Github,
  Layer.succeed(Checkout.Service, { at: () => Effect.succeed(process.env.CLAUDE_CONFIG_DIR!) }),
)
const Services = Layer.mergeAll(
  Reviewer.layer(config.limits).pipe(Layer.provideMerge(Panel.layer)),
  Triggers.layer(config.triggers),
  SignedIn,
  fakeHealth,
  UsageLive,
).pipe(Layer.provideMerge(Adapters), Layer.provideMerge(BunServices.layer))
const runtime = ManagedRuntime.make(Services)
const context = await runtime.context()
const { handler } = HttpRouter.toWebHandler(
  Layer.mergeAll(Rpc.routes(config), Auth.routes(config), Http.routes(config)).pipe(Layer.provide(Layer.succeedContext(context))),
  { disableLogger: true },
)
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 7520,
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/_fixture") return Response.json(counts)
    if (url.pathname === "/_mode" && request.method === "POST") {
      mode = await request.text()
      await Bun.write(resolve(process.env.CODEX_HOME!, "mode"), mode)
      // A new service instance simulates the next cache period without a fifteen-minute test delay.
      probe = (await Effect.runPromise(Usage.make(config.agent).pipe(Effect.provide(Layer.mergeAll(providerClient, BunServices.layer))))).read
      return Response.json(await Effect.runPromise(probe))
    }
    if (url.pathname === "/_usage") return Response.json(await Effect.runPromise(probe))
    if (url.pathname === "/_panel") {
      await runtime.runPromise(Effect.flatMap(Store.Service, (store) => store.savePanel("acme/api", 7, 77)))
      return Response.json({ ok: true })
    }
    return handler(request)
  },
})
console.log(`E2E API ready on ${server.port}`)
