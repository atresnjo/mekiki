// Failure paths this rehearsal exercises before the Effect refactor:
// - an agent chunk fails: the posted review must describe the missing files;
// - git is unavailable: the tarball must still give the agent the actual code;
// - a review is cancelled: its subprocess and stream must stop;
// - a database query fails: it must remain a typed failure, and RPC must sanitize it;
// - an invalid app key must fail in the typed GitHub channel, without crashing a fiber.
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import { RpcTest } from "effect/rpc"
import { Agent } from "../src/agent.ts"
import { Checkout } from "../src/checkout.ts"
import { Database } from "../src/database.ts"
import { GitHub } from "../src/github.ts"
import { Panel } from "../src/panel.ts"
import { Reviewer } from "../src/reviewer.ts"
import { AuthenticatedLive, HandlersLive } from "../src/rpc-server.ts"
import { GlanceRpcs } from "../src/rpc.ts"
import { Store } from "../src/store.ts"
import { configFrom, fakeAuth, fakeHealth, fakeUsage, memoryDatabase } from "./support.ts"

test("Effect end-to-end rehearsal: real HTTP, agent processes, checkout, persistence and RPC", async () => {
  const dir = mkdtempSync(join(tmpdir(), "glance-effect-e2e-"))
  const fixture = join(dir, "agent")
  let notifyReady: (pid: number) => void = () => {}
  const agentReady = new Promise<number>((resolve) => {
    notifyReady = resolve
  })
  const requests: Array<string> = []
  const posted: Array<unknown> = []
  const source = join(dir, "source")
  mkdirSync(source)
  writeFileSync(join(source, "good.ts"), "export const good = true\n")
  writeFileSync(join(source, "broken.ts"), "export const broken = true\n")
  const archive = Bun.spawnSync(["tar", "-czf", "-", "-C", dir, "source"])
  expect(archive.exitCode).toBe(0)
  const diff = (file: string) =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-export const old = true\n+export const value = true\n`
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(`${request.method} ${path}`)
      if (path === "/agent-ready") {
        notifyReady(Number(await request.text()))
        return new Response("ready")
      }
      if (request.method !== "GET") {
        const body: unknown = await request.json()
        if (path.endsWith("/reviews")) posted.push(body)
        return Response.json({ id: 42 })
      }
      if (path.includes("/tarball/")) return new Response(Uint8Array.from(archive.stdout))
      if (request.headers.get("accept")?.includes("github.diff")) return new Response(diff("good.ts") + (path.endsWith("/2") ? diff("broken.ts") : ""))
      if (path.includes("/pulls/"))
        return Response.json({
          title: path.endsWith("/3") ? "hold" : "rehearsal",
          body: "",
          state: "open",
          draft: false,
          html_url: `https://github.com/acme/api/pull/${path.split("/").at(-1)}`,
          head: { sha: "abc123" },
        })
      return new Response("no git server", { status: 404 })
    },
  })
  writeFileSync(
    fixture,
    `#!${process.execPath}
const prompt = await Bun.stdin.text()
if (prompt.includes("# Pull request: hold")) {
  await fetch(${JSON.stringify(new URL("/agent-ready", server.url).href)}, { method: "POST", body: String(process.pid) })
  await new Promise(() => {})
}
if (prompt.includes("### broken.ts")) { console.error("fixture chunk failed"); process.exit(1) }
if (!(await Bun.file("good.ts").exists())) { console.error("checkout missing"); process.exit(2) }
console.log(JSON.stringify({ structured_output: { summary: "Read the actual code.", findings: [] }, usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 }, total_cost_usd: 0.002 }))
`,
  )
  chmodSync(fixture, 0o755)
  const config = configFrom({
    GITHUB_API_URL: server.url.href.replace(/\/$/, ""),
    GITHUB_TOKEN: "fixture-token",
    CLAUDE_BIN: fixture,
    GLANCE_CHECKOUTS: join(dir, "checkouts"),
    CHUNK_CHARS: "1",
    AGENT_TIMEOUT_SECONDS: "10",
  })
  const adapters = Layer.mergeAll(
    GitHub.layer(config.github),
    Agent.layer(config.agent),
    Store.layer({ defaults: config.defaults }).pipe(Layer.provideMerge(memoryDatabase)),
  )
  const services = Reviewer.layer(config.limits).pipe(
    Layer.provideMerge(Layer.mergeAll(Panel.layer, Checkout.layer(config.checkouts))),
    Layer.provideMerge(adapters),
  )
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reviewer = yield* Reviewer.Service
        const store = yield* Store.Service
        const pr = (number: number) => ({ owner: "acme", repo: "api", number })
        const whole = yield* reviewer.run(pr(1), { trigger: "e2e" })
        expect(whole.status).toBe("done")
        expect(whole.posted).toBe(true)
        expect(whole.error).toBeNull()
        // what the cli reported it spent is kept with the review
        expect(whole.usage).toEqual({ calls: 1, inputTokens: 1000, cachedInputTokens: 900, outputTokens: 50, costUsd: 0.002 })
        const partial = yield* reviewer.run(pr(2), { trigger: "e2e" })
        expect(partial.status).toBe("done")
        expect(partial.unreviewed).toEqual(["broken.ts"])
        expect(partial.posted).toBe(true)
        expect(JSON.stringify(posted)).toContain("Partial review")

        const changes = yield* reviewer.subscribe
        yield* reviewer.start(pr(3), { trigger: "e2e cancellation" })
        const pid = yield* Effect.promise(() => agentReady).pipe(Effect.timeout("5 seconds"))
        yield* reviewer.cancel(pr(3))
        const cancelled = yield* Stream.fromSubscription(changes).pipe(
          Stream.filter((r) => r.number === 3 && r.status === "cancelled"),
          Stream.take(1),
          Stream.runCollect,
        )
        expect(cancelled[0]?.status).toBe("cancelled")
        expect(() => process.kill(pid, 0)).toThrow()

        const db = yield* Database.Service
        yield* db.execute(sql`drop table reviews`)
        const failure = yield* store.list(10).pipe(Effect.exit)
        expect(failure._tag).toBe("Failure")
        const typed = failure._tag === "Failure" ? Cause.findErrorOption(failure.cause) : Option.none()
        expect(Option.isSome(typed) && Schema.is(Schema.Struct({ _tag: Schema.Literal("StoreError") }))(typed.value)).toBe(true)
        const client = yield* RpcTest.makeClient(GlanceRpcs).pipe(
          Effect.provide(Layer.mergeAll(HandlersLive(config), AuthenticatedLive).pipe(Layer.provide(Layer.mergeAll(fakeAuth(false), fakeHealth, fakeUsage)))),
        )
        const rpcFailure = yield* client.ListReviews({ before: 100 }).pipe(Effect.flip)
        expect(rpcFailure._tag).toBe("Failed")
        expect(rpcFailure.message).not.toContain("reviews")

        // Bad key parsing is an operational configuration failure, not a defect.
        const invalid = { ...config.github, app: { ...config.github.app, id: Option.some("1"), privateKey: Option.some(Redacted.make("invalid pem")) } }
        const invalidKey = yield* Effect.flatMap(GitHub.Service, (github) => github.pullRequest(pr(1))).pipe(Effect.provide(GitHub.layer(invalid)), Effect.exit)
        const keyFailure = invalidKey._tag === "Failure" ? Cause.findErrorOption(invalidKey.cause) : Option.none()
        expect(Option.isSome(keyFailure) && keyFailure.value._tag === "GitHubError").toBe(true)
        return { whole, partial, cancelled: cancelled[0], rpcFailure: rpcFailure._tag, typedDatabaseFailure: Option.isSome(typed), requests, posted }
      }).pipe(Effect.scoped, Effect.provide(services), Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    )
    mkdirSync(".data", { recursive: true })
    writeFileSync(".data/effect-e2e.json", JSON.stringify({ command: "bun run test:e2e", passedAt: new Date().toISOString(), ...result }, null, 2))
  } finally {
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
