import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Stream } from "effect"
import { type RpcClient, type RpcGroup, RpcTest } from "effect/rpc"
import { AuthenticatedLive, HandlersLive } from "../src/rpc-server.ts"
import { GlanceRpcs, PAGE } from "../src/rpc.ts"
import { Store } from "../src/store.ts"
import { type Calls, configFrom, fakeAgent, fakeAuth, fakeGitHub, fakeHealth, fakeReviewer, fakeUsage, memoryStore, review } from "./support.ts"

const run = <A, E>(signIn: boolean, f: (client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof GlanceRpcs>>, calls: Calls) => Effect.Effect<A, E, Store.Service>) => {
  const config = configFrom({})
  const calls: Calls = { started: [], cancelled: [] }
  const services = Layer.mergeAll(memoryStore(config), fakeAuth(signIn), fakeReviewer(calls), fakeAgent, fakeHealth, fakeUsage, fakeGitHub([])).pipe(
    Layer.provideMerge(BunServices.layer),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(GlanceRpcs)
      return yield* f(client, calls)
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(HandlersLive(config), AuthenticatedLive).pipe(Layer.provideMerge(services)))),
  )
}

test("with signing in on, a call without a session is refused, and one with it goes through as its user", async () => {
  const result = await run(true, (client, calls) =>
    Effect.gen(function* () {
      const refused = yield* client.GetStatus(undefined).pipe(Effect.flip)
      const status = yield* client.GetStatus(undefined, { headers: { cookie: "signed-in" } })
      yield* client.StartReview({ url: "https://github.com/acme/api/pull/7", dryRun: false }, { headers: { cookie: "signed-in" } })
      return { refused, status, trigger: calls.started[0]?.options.trigger }
    }),
  )
  expect(result.refused._tag).toBe("Unauthorized")
  expect(result.status).toEqual({
    agents: { claude: "claude 1.0", codex: null, api: null },
    webhook: false,
    auth: true,
    user: { id: "u1", name: "Alice", email: "alice@acme.com", image: null },
  })
  // who started it is on the review
  expect(result.trigger).toBe("manual by alice@acme.com")
})

test("refusals come back typed: a bad url, an unknown review, a model the cli doesn't offer", async () => {
  const result = await run(false, (client) =>
    Effect.gen(function* () {
      const badUrl = yield* client.StartReview({ url: "not a pr", dryRun: false }).pipe(Effect.flip)
      const unknown = yield* client.RetryReview({ id: 404 }).pipe(Effect.flip)
      const settings = yield* client.GetSettings(undefined)
      const model = yield* client.SaveSettings({ ...settings, model: "gpt-1" }).pipe(Effect.flip)
      return { badUrl, unknown, model }
    }),
  )
  expect(result.badUrl._tag).toBe("Invalid")
  expect(result.unknown._tag).toBe("NotFound")
  expect(result.model._tag).toBe("Invalid")
})

test("starting and retrying reach the reviewer with the depth asked for", async () => {
  const calls = await run(false, (client, calls) =>
    Effect.gen(function* () {
      const store = yield* Store.Service
      const created = yield* store.create(review({ repo: "acme/api", number: 7 }))
      yield* client.StartReview({ url: "https://github.com/acme/api/pull/7", dryRun: true, depth: "high" })
      yield* client.RetryReview({ id: created.id, depth: "medium" })
      yield* client.CancelReview({ id: created.id })
      return calls
    }),
  )
  expect(calls.started.map((s) => [s.pr, s.options.trigger, s.options.dryRun ?? false, s.options.overrides?.depth])).toEqual([
    [{ owner: "acme", repo: "api", number: 7 }, "manual", true, "high"],
    [{ owner: "acme", repo: "api", number: 7 }, "retry medium", false, "medium"],
  ])
  expect(calls.cancelled).toEqual([{ owner: "acme", repo: "api", number: 7 }])
})

test("the stream starts with the latest page; older reviews come a page at a time", async () => {
  const result = await run(false, (client) =>
    Effect.gen(function* () {
      const store = yield* Store.Service
      for (let i = 0; i < PAGE + 5; i++) yield* store.create(review({ number: i }))
      const first = yield* client.WatchReviews(undefined).pipe(Stream.take(1), Stream.runCollect)
      const snapshot = first[0]
      const oldest = snapshot?._tag === "Snapshot" ? (snapshot.reviews.at(-1)?.id ?? 0) : 0
      const older = yield* client.ListReviews({ before: oldest })
      return { snapshot: snapshot?._tag === "Snapshot" ? snapshot.reviews.length : 0, older: older.map((r) => r.id) }
    }),
  )
  expect(result.snapshot).toBe(PAGE)
  expect(result.older).toEqual([5, 4, 3, 2, 1])
})

test("repository settings: saved tidied, listed, removed; a bad name, login or overlong rules are refused", async () => {
  const result = await run(false, (client) =>
    Effect.gen(function* () {
      const base = { mode: null, depth: null, rules: "", blockedAuthors: [], allowedAuthors: [], exclude: [] }
      const saved = yield* client.SaveRepoSettings({ ...base, repo: " Acme/API ", mode: "auto", blockedAuthors: [" dependabot[bot] ", "dependabot[bot]", ""] })
      const listed = yield* client.GetRepoSettings(undefined)
      const badRepo = yield* client.SaveRepoSettings({ ...base, repo: "acme" }).pipe(Effect.flip)
      const badLogin = yield* client.SaveRepoSettings({ ...base, repo: "acme/api", allowedAuthors: ["not a login"] }).pipe(Effect.flip)
      const settings = yield* client.GetSettings(undefined)
      const long = yield* client.SaveSettings({ ...settings, rules: "x".repeat(5000) }).pipe(Effect.flip)
      yield* client.DeleteRepoSettings({ repo: "acme/api" })
      return { saved, listed, badRepo, badLogin, long, after: yield* client.GetRepoSettings(undefined) }
    }),
  )
  expect(result.saved).toMatchObject({ repo: "acme/api", mode: "auto", blockedAuthors: ["dependabot[bot]"] })
  expect(result.listed).toEqual([result.saved])
  expect([result.badRepo._tag, result.badLogin._tag, result.long._tag]).toEqual(["Invalid", "Invalid", "Invalid"])
  expect(result.after).toEqual([])
})

test("adding a repository suggests where glance is installed and what it has reviewed, once each", async () => {
  const repos = await run(false, (client) =>
    Effect.gen(function* () {
      const store = yield* Store.Service
      yield* store.create(review({ repo: "acme/api", number: 1 }))
      yield* store.create(review({ repo: "Other/Old", number: 2 }))
      return yield* client.GetRepos(undefined)
    }),
  )
  expect(repos).toEqual(["acme/api", "acme/web", "other/old"])
})
