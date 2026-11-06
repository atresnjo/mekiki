import { expect, test } from "bun:test"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option, Schedule } from "effect"
import { Database } from "../src/database.ts"
import { type PrRef, repoSettings } from "../src/domain.ts"
import { appJwt, GitHub } from "../src/github.ts"
import { Reviewer } from "../src/reviewer.ts"
import { settings as settingsTable } from "../src/schema.ts"
import { Store } from "../src/store.ts"
import { configFrom, fakeAgent, fakeCheckout, fakeGitHub, fakePanel, memoryDatabase, memoryStore, review } from "./support.ts"

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

test("a partial review isn't where the next one starts from; one saved before partial reviews existed still reads", async () => {
  const [last, old] = await withStore((store) =>
    Effect.gen(function* () {
      const whole = yield* store.create(review({ headSha: "a1" }))
      yield* store.create(review({ headSha: "b2", unreviewed: ["src/a.ts"] }))
      // written by an older mekiki: no unreviewed key at all
      const { unreviewed: _, ...before } = review({ headSha: "c3", repo: "o/old" })
      const legacy = yield* store.create(before as never)
      return [Option.map(yield* store.lastDone("o/r", 1), (r) => r.id === whole.id), yield* store.get(legacy.id)]
    }),
  )
  expect(last).toEqual(Option.some(true))
  expect(Option.map(old, (r) => r.unreviewed)).toEqual(Option.some([]))
})

test("past MAX_QUEUED_REVIEWS a review is turned away, and says so; replacing a running one is fine", async () => {
  const busy = configFrom({ MAX_QUEUED_REVIEWS: "1" })
  const shown: Array<{ readonly pr: PrRef; readonly kind: string }> = []
  // github never answers: the first review stays running
  const stuck = Layer.effect(
    GitHub.Service,
    Effect.map(GitHub.Service, (fake) => GitHub.Service.of({ ...fake, pullRequest: () => Effect.never })),
  ).pipe(Layer.provide(fakeGitHub([])))
  const rows = await Effect.runPromise(
    Effect.gen(function* () {
      const reviewer = yield* Reviewer.Service
      const store = yield* Store.Service
      const pr = (number: number) => ({ owner: "o", repo: "r", number })
      yield* reviewer.start(pr(1), { trigger: "manual" })
      yield* reviewer.start(pr(2), { trigger: "manual" })
      yield* reviewer.start(pr(1), { trigger: "manual again" })
      return (yield* store.list(10)).map((r) => ({ number: r.number, status: r.status, summary: r.summary }))
    }).pipe(
      Effect.scoped,
      Effect.provide(Reviewer.layer(busy.limits)),
      Effect.provide(Layer.mergeAll(stuck, fakeAgent, fakePanel(shown), fakeCheckout).pipe(Layer.provideMerge(memoryStore(busy)))),
      Effect.provide(BunServices.layer),
    ),
  )
  expect(rows.map((r) => [r.number, r.status])).toEqual([
    [1, "running"],
    [2, "skipped"],
    [1, "cancelled"],
  ])
  expect(rows[1]?.summary).toContain("mekiki is busy")
  expect(shown.some((s) => s.pr.number === 2 && s.kind === "finished")).toBe(true)
})

test("settings saved before rules and author lists existed still read, the new fields from the environment", async () => {
  const env = configFrom({ MEKIKI_BLOCKED_AUTHORS: "dependabot[bot]", MEKIKI_EXCLUDE: "*.snap" })
  const settings = await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database.Service
      // written by an older mekiki
      yield* db.insert(settingsTable).values({
        id: 1,
        data: { agent: "codex", model: "", depth: "high", mode: "auto", postComments: false, maxFindings: 5, minConfidence: 0.7 } as never,
      })
      return yield* (yield* Store.Service).settings
    }).pipe(Effect.provide(Store.layer({ defaults: env.defaults }).pipe(Layer.provideMerge(memoryDatabase)))),
  )
  expect(settings).toMatchObject({
    agent: "codex",
    depth: "high",
    mode: "auto",
    rules: "",
    blockedAuthors: ["dependabot[bot]"],
    allowedAuthors: [],
    exclude: ["*.snap"],
  })
})

test("a repository's settings go on top of the global ones, under any case, until they're removed", async () => {
  const result = await withStore((store) =>
    Effect.gen(function* () {
      yield* store.saveSettings({ ...(yield* store.settings), rules: "Never throw.", exclude: ["*.snap"] })
      yield* store.saveRepoSettings({
        ...repoSettings("acme/api"),
        repo: "Acme/API",
        depth: "high",
        rules: "Migrations must be reversible.",
        exclude: ["/docs/**"],
      })
      const own = yield* store.settingsFor("acme/Api")
      const other = yield* store.settingsFor("acme/web")
      const listed = yield* store.repoSettings
      yield* store.deleteRepoSettings("ACME/api")
      return { own, other, listed, after: yield* store.settingsFor("acme/api") }
    }),
  )
  expect(result.own).toMatchObject({ depth: "high", mode: "ask", rules: "Never throw.\n\nMigrations must be reversible.", exclude: ["*.snap", "/docs/**"] })
  expect(result.other).toMatchObject({ depth: "light", rules: "Never throw.", exclude: ["*.snap"] })
  expect(result.listed.map((r) => [r.repo, r.depth])).toEqual([["acme/api", "high"]])
  expect(result.after).toEqual(result.other)
})

test("the repositories mekiki has reviewed, once each", async () => {
  const repos = await withStore((store) =>
    Effect.gen(function* () {
      for (const repo of ["acme/web", "acme/api", "acme/web"]) yield* store.create(review({ repo }))
      return yield* store.reviewedRepos
    }),
  )
  expect(repos).toEqual(["acme/api", "acme/web"])
})

test("a review runs with its repository's settings", async () => {
  const depths = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store.Service
      const reviewer = yield* Reviewer.Service
      yield* store.saveRepoSettings({ ...repoSettings("acme/api"), depth: "high" })
      // the fake github fails the review: what it was recorded with is what counts
      const own = yield* reviewer.run({ owner: "acme", repo: "api", number: 1 }, { trigger: "manual", dryRun: true })
      const other = yield* reviewer.run({ owner: "acme", repo: "web", number: 1 }, { trigger: "manual", dryRun: true })
      const asked = yield* reviewer.run({ owner: "acme", repo: "api", number: 2 }, { trigger: "manual", dryRun: true, overrides: { depth: "medium" } })
      return [own.depth, other.depth, asked.depth]
    }).pipe(
      Effect.scoped,
      Effect.provide(Reviewer.layer(config.limits)),
      Effect.provide(Layer.mergeAll(fakeGitHub([]), fakeAgent, fakePanel([]), fakeCheckout).pipe(Layer.provideMerge(memoryStore(config)))),
      Effect.provide(BunServices.layer),
    ),
  )
  expect(depths).toEqual(["high", "light", "medium"])
})
