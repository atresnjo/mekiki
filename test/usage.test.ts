import { afterAll, beforeAll, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import type { SubscriptionUsage } from "../src/rpc.ts"
import { Usage } from "../src/usage.ts"

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
beforeAll(() => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "fixture-oauth"
})
afterAll(() => {
  if (token === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = token
})

const ok = () => Response.json({ five_hour: { utilization: 42, resets_at: "2030-01-01T00:00:00Z" } })
const limited =
  (headers: Record<string, string> = {}) =>
  () =>
    new Response("private upstream diagnostic", { status: 429, headers })

// Each Claude call takes the next response, then repeats the last one. Codex has no binary, so it is always unavailable.
const run = <A>(responses: ReadonlyArray<() => Response>, f: (read: Effect.Effect<SubscriptionUsage>, calls: () => number) => Effect.Effect<A>) => {
  let calls = 0
  const client = HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, responses[Math.min(calls++, responses.length - 1)]!())))
  return Effect.runPromise(
    Effect.gen(function* () {
      const usage = yield* Usage.make({ codexBin: "/nonexistent/codex" })
      return yield* f(usage.read, () => calls)
    }).pipe(Effect.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), BunServices.layer, TestClock.layer()))),
  )
}

test("a Claude 429 waits out Retry-After, says when the next check is, and leaks nothing", async () => {
  const result = await run([limited({ "retry-after": "1708" }), ok], (read, calls) =>
    Effect.gen(function* () {
      const first = yield* read
      yield* TestClock.adjust("20 minutes")
      const waiting = yield* read
      const callsWhileWaiting = calls()
      yield* TestClock.adjust("9 minutes")
      const after = yield* read
      return { first, waiting, callsWhileWaiting, after, calls: calls() }
    }),
  )
  expect(result.first.claude).toEqual({ windows: [], checkedAt: 0, unavailable: "Claude is rate limiting usage checks. Next check in 29 minutes." })
  expect(result.waiting.claude.unavailable).toBe("Claude is rate limiting usage checks. Next check in 9 minutes.")
  expect(result.callsWhileWaiting).toBe(1)
  expect(result.after.claude.unavailable).toBeNull()
  expect(result.after.claude.windows).toHaveLength(1)
  expect(result.calls).toBe(2)
  expect(JSON.stringify(result)).not.toContain("private upstream diagnostic")
  expect(JSON.stringify(result)).not.toContain("fixture-oauth")
})

test("a Claude 429 without a usable Retry-After waits 30 minutes", async () => {
  for (const headers of [{}, { "retry-after": "soon" }] as Array<Record<string, string>>) {
    const result = await run([limited(headers), ok], (read, calls) =>
      Effect.gen(function* () {
        const first = yield* read
        yield* TestClock.adjust("29 minutes")
        yield* read
        const callsBefore = calls()
        yield* TestClock.adjust("1 minute")
        yield* read
        return { first, callsBefore, calls: calls() }
      }),
    )
    expect(result.first.claude.unavailable).toBe("Claude is rate limiting usage checks. Next check in 30 minutes.")
    expect(result.callsBefore).toBe(1)
    expect(result.calls).toBe(2)
  }
})

test("a short Retry-After still waits for Claude's own cadence", async () => {
  const result = await run([limited({ "retry-after": "60" }), ok], (read, calls) =>
    Effect.gen(function* () {
      const first = yield* read
      yield* TestClock.adjust("14 minutes")
      yield* read
      const callsBefore = calls()
      yield* TestClock.adjust("1 minute")
      yield* read
      return { first, callsBefore, calls: calls() }
    }),
  )
  expect(result.first.claude.unavailable).toBe("Claude is rate limiting usage checks. Next check in 15 minutes.")
  expect(result.callsBefore).toBe(1)
  expect(result.calls).toBe(2)
})

test("Claude is checked every 15 minutes, independently of Codex's 5", async () => {
  const result = await run([ok], (read, calls) =>
    Effect.gen(function* () {
      yield* read
      yield* TestClock.adjust("5 minutes")
      const fiveMinutes = yield* read
      const callsAtFive = calls()
      yield* TestClock.adjust("10 minutes")
      const fifteenMinutes = yield* read
      return { fiveMinutes, callsAtFive, fifteenMinutes, calls: calls() }
    }),
  )
  expect(result.fiveMinutes.claude.checkedAt).toBe(0)
  expect(result.fiveMinutes.codex.checkedAt).toBe(5 * 60_000)
  expect(result.callsAtFive).toBe(1)
  expect(result.fifteenMinutes.claude.checkedAt).toBe(15 * 60_000)
  expect(result.calls).toBe(2)
})
