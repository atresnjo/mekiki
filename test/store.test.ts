import { expect, test } from "bun:test"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option, Schedule } from "effect"
import type { PrRef } from "../src/domain.ts"
import { appJwt } from "../src/github.ts"
import { Reviewer } from "../src/reviewer.ts"
import { Store } from "../src/store.ts"
import { configFrom, fakeAgent, fakeCheckout, fakeGitHub, fakePanel, memoryStore, review } from "./support.ts"

const config = configFrom({})
const withStore = <A, E>(f: (store: Store.Interface) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* Store.Service)
    }).pipe(Effect.provide(memoryStore(config))),
  )

test("a webhook delivery is claimed once; a released one can be claimed again", async () => {
  const claims = await withStore((store) =>
    Effect.gen(function* () {
      const first = yield* store.claimDelivery("d1")
      const second = yield* store.claimDelivery("d1")
      yield* store.releaseDelivery("d1")
      const afterRelease = yield* store.claimDelivery("d1")
      return [first, second, afterRelease]
    }),
  )
  expect(claims).toEqual([true, false, true])
})

test("pages of older reviews, newest first", async () => {
  const pages = await withStore((store) =>
    Effect.gen(function* () {
      for (let i = 0; i < 5; i++) yield* store.create(review({ number: i }))
      return [(yield* store.list(2)).map((r) => r.id), (yield* store.listBefore(4, 2)).map((r) => r.id), (yield* store.listBefore(2, 2)).map((r) => r.id)]
    }),
  )
  expect(pages).toEqual([[5, 4], [3, 2], [1]])
})

test("saves of different fields don't overwrite each other; a comment id past 2^31 comes back whole", async () => {
  const [saved, panel] = await withStore((store) =>
    Effect.gen(function* () {
      const { id } = yield* store.create(review({ status: "running" }))
      yield* Effect.all([store.update(id, { files: 7 }), store.update(id, { summary: "s" }), store.update(id, { status: "done" })], {
        concurrency: "unbounded",
      })
      yield* store.savePanel("o/r", 1, 1)
      yield* store.savePanel("o/r", 1, 3_000_000_000)
      return [yield* store.get(id), yield* store.panel("o/r", 1)]
    }),
  )
  expect(Option.map(saved, (r) => [r.files, r.summary, r.status])).toEqual(Option.some([7, "s", "done"]))
  expect(panel).toEqual(Option.some(3_000_000_000))
})

test("an app's jwt is signed with its key and names the app", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwt = appJwt("123", privateKey.export({ type: "pkcs1", format: "pem" }).toString(), 1_700_000_000_000)
  const [header = "", payload = "", signature = ""] = jwt.split(".")
  expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature, "base64url")).toBe(true)
  expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: "123" })
})

test("after a restart, a review cut short is started again once; an old one or a restart itself is marked failed", async () => {
  const shown: Array<{ readonly pr: PrRef; readonly kind: string }> = []
  const rows = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store.Service
      const now = Date.now()
      yield* store.create(review({ number: 1, status: "running", startedAt: now - 60_000, depth: "high", dryRun: true }))
      yield* store.create(review({ number: 2, status: "running", startedAt: now - 3 * 3600_000 }))
      yield* store.create(review({ number: 3, status: "running", startedAt: now - 60_000, trigger: "resumed manual" }))
      yield* store.savePanel("o/r", 2, 99)
      // building the reviewer is the restart
      yield* Layer.build(Reviewer.layer(config.limits))
      // the resumed review runs in the background and fails on the fake github: until nothing is running
      yield* store.interrupted.pipe(
        Effect.repeat({ until: (running) => running.length === 0, schedule: Schedule.spaced("5 millis") }),
        Effect.timeout("2 seconds"),
      )
      return (yield* store.list(10)).map((r) => ({ number: r.number, status: r.status, trigger: r.trigger, depth: r.depth, dryRun: r.dryRun }))
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(fakeGitHub([]), fakeAgent, fakePanel(shown), fakeCheckout).pipe(Layer.provideMerge(memoryStore(config)))),
      Effect.provide(BunServices.layer),
    ),
  )
  expect(rows).toEqual([
    { number: 1, status: "failed", trigger: "resumed manual", depth: "high", dryRun: true },
    { number: 3, status: "failed", trigger: "resumed manual", depth: "light", dryRun: false },
    { number: 2, status: "failed", trigger: "manual", depth: "light", dryRun: false },
    { number: 1, status: "cancelled", trigger: "manual", depth: "high", dryRun: true },
  ])
  // the old review's comment on github says it failed, not "reviewing…"
  expect(shown).toEqual([{ pr: { owner: "o", repo: "r", number: 2 }, kind: "finished" }])
})
