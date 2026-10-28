import { afterAll, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, PubSub } from "effect"
import { HttpRouter } from "effect/http"
import { type PrRef, repoSettings, type Review } from "../src/domain.ts"
import * as Http from "../src/http.ts"
import { render } from "../src/panel.ts"
import { Reviewer } from "../src/reviewer.ts"
import { Store } from "../src/store.ts"
import { Triggers } from "../src/triggers.ts"
import { type Calls, configFrom, fakeCheckout, fakeGitHub, fakePanel, fakeReviewer, memoryStore } from "./support.ts"

const SECRET = "whsec"
const config = configFrom({ GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_WEBHOOK_MAX_BYTES: "10000", GLANCE_REVIEWS_PER_USER_HOUR: "5" })
const calls: Calls = { started: [], cancelled: [] }
const acknowledged: Array<number> = []
const shown: Array<{ readonly pr: PrRef; readonly kind: string }> = []

const github = fakeGitHub(acknowledged, { maintainer: "maintain", writer: "write", spammer: "write", reader: "read" })
const services = Layer.mergeAll(memoryStore(config), fakeReviewer(calls), fakePanel(shown), fakeCheckout, Triggers.layer(config.triggers)).pipe(
  Layer.provideMerge(github),
)
// glance's comment on acme/api#7 is comment 500
const seeded = Layer.effectDiscard(Effect.flatMap(Store.Service, (store) => store.savePanel("acme/api", 7, 500)))
const { handler, dispose } = HttpRouter.toWebHandler(
  Layer.mergeAll(Http.routes(config), seeded).pipe(Layer.provide(services), Layer.provide(BunServices.layer)),
  { disableLogger: true },
)
afterAll(() => dispose())

let deliveries = 0
const deliver = (event: string, payload: unknown, options: { readonly delivery?: string; readonly signature?: string } = {}) => {
  const body = JSON.stringify(payload)
  return handler(
    new Request("http://glance/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": options.delivery ?? `delivery-${++deliveries}`,
        "x-hub-signature-256": options.signature ?? `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
      },
    }),
  )
}

const repository = { name: "api", owner: { login: "acme" } }
const user = (login: string, type = "User") => ({ login, type })
const pullRequest = (action: string, extra: object = {}) => ({
  action,
  number: 7,
  pull_request: { draft: false, head: { sha: "abc" }, labels: [], user: user("writer") },
  repository,
  sender: user("maintainer"),
  ...extra,
})
const comment = (body: string, by: string, extra: object = {}) => ({
  action: "created",
  issue: { number: 7, pull_request: {} },
  comment: { id: 42, body, user: user(by) },
  repository,
  sender: user(by),
  ...extra,
})
/** someone ticks the High box in comment `id` */
const tick = (id: number, by: string) => {
  const before = render({ kind: "waiting" })
  return {
    action: "edited",
    issue: { number: 7, pull_request: {} },
    comment: { id, body: before.replace(/- \[ \] (\*\*High\*\*)/, "- [x] $1"), user: user("glance[bot]", "Bot") },
    changes: { body: { from: before } },
    repository,
    sender: user(by),
  }
}

test("a delivery that isn't signed with the secret is refused", async () => {
  const response = await deliver("ping", { zen: "hi" }, { signature: "sha256=00" })
  expect(response.status).toBe(401)
})

test("a redelivered delivery is acted on once", async () => {
  const before = calls.started.length
  const first = await deliver("pull_request", pullRequest("labeled", { label: { name: "glance:high" } }), { delivery: "same" })
  const again = await deliver("pull_request", pullRequest("labeled", { label: { name: "glance:high" } }), { delivery: "same" })
  expect(first.status).toBe(202)
  expect(await again.json()).toEqual({ ok: true, duplicate: true })
  expect(calls.started.length - before).toBe(1)
  expect(calls.started.at(-1)?.options.overrides?.depth).toBe("high")
})

test("too big, or not what github sends: refused without touching anything", async () => {
  const big = await deliver("ping", { padding: "x".repeat(20_000) })
  const malformed = await deliver("pull_request", { action: "opened" })
  expect(big.status).toBe(413)
  expect(malformed.status).toBe(400)
})

test("closing a pull request cancels its review", async () => {
  await deliver("pull_request", pullRequest("closed"))
  expect(calls.cancelled.at(-1)).toEqual({ owner: "acme", repo: "api", number: 7 })
})

test("/glance high in a comment starts a review at high and says it saw it", async () => {
  const response = await deliver("issue_comment", comment("/glance high please", "writer"))
  expect(response.status).toBe(202)
  expect(calls.started.at(-1)?.options).toMatchObject({ trigger: "comment high", overrides: { depth: "high" } })
  expect(acknowledged).toContain(42)
})

test("in ask mode an opened pull request gets the checkboxes, not a review", async () => {
  const before = calls.started.length
  const response = await deliver("pull_request", pullRequest("opened"))
  expect(await response.json()).toMatchObject({ reviewing: false, asked: true })
  expect(calls.started.length).toBe(before)
  expect(shown.at(-1)).toEqual({ pr: { owner: "acme", repo: "api", number: 7 }, kind: "waiting" })
})

test("a comment command from someone without write permission starts nothing", async () => {
  const before = calls.started.length
  const reader = await deliver("issue_comment", comment("/glance high", "reader"))
  const stranger = await deliver("issue_comment", comment("/glance", "drive-by"))
  const bot = await deliver(
    "issue_comment",
    comment("/glance", "dependabot[bot]", { comment: { id: 43, body: "/glance", user: user("dependabot[bot]", "Bot") } }),
  )
  expect(await reader.json()).toMatchObject({ reviewing: false, refused: expect.stringContaining("read permission") })
  expect(await stranger.json()).toMatchObject({ reviewing: false })
  expect(await bot.json()).toMatchObject({ reviewing: false })
  expect(calls.started.length).toBe(before)
})

test("a ticked box counts only in glance's own comment, and only from someone who may", async () => {
  const before = calls.started.length
  const copy = await deliver("issue_comment", tick(999, "maintainer"))
  const reader = await deliver("issue_comment", tick(500, "reader"))
  expect(await copy.json()).toMatchObject({ reviewing: false, refused: "not glance's comment" })
  expect(await reader.json()).toMatchObject({ reviewing: false })
  expect(calls.started.length).toBe(before)
  const maintainer = await deliver("issue_comment", tick(500, "maintainer"))
  expect(maintainer.status).toBe(202)
  expect(calls.started.at(-1)?.options).toMatchObject({ trigger: "checkbox high", overrides: { depth: "high" } })
})

test("a label from someone without the permission starts nothing", async () => {
  const before = calls.started.length
  const response = await deliver("pull_request", pullRequest("labeled", { label: { name: "glance:high" }, sender: user("reader") }))
  expect(await response.json()).toMatchObject({ reviewing: false })
  expect(calls.started.length).toBe(before)
})

test("each person gets a few reviews an hour", async () => {
  const statuses: Array<number> = []
  for (let i = 0; i < 6; i++) statuses.push((await deliver("issue_comment", comment("/glance", "spammer"))).status)
  expect(statuses).toEqual([202, 202, 202, 202, 202, 429])
})

test("in auto mode a stranger's pull request gets the checkboxes; a collaborator's is reviewed", async () => {
  const auto = configFrom({ GITHUB_WEBHOOK_SECRET: SECRET, GLANCE_MODE: "auto" })
  const autoCalls: Calls = { started: [], cancelled: [] }
  const autoShown: Array<{ readonly pr: PrRef; readonly kind: string }> = []
  const web = HttpRouter.toWebHandler(
    Http.routes(auto).pipe(
      Layer.provide(
        Layer.mergeAll(memoryStore(auto), fakeReviewer(autoCalls), fakePanel(autoShown), fakeCheckout, Triggers.layer(auto.triggers)).pipe(
          Layer.provideMerge(fakeGitHub([], { writer: "write" })),
        ),
      ),
      Layer.provide(BunServices.layer),
    ),
    { disableLogger: true },
  )
  const send = (payload: unknown) => {
    const body = JSON.stringify(payload)
    return web.handler(
      new Request("http://glance/api/webhooks/github", {
        method: "POST",
        body,
        headers: { "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}` },
      }),
    )
  }
  const fork = await send(pullRequest("opened", { pull_request: { draft: false, head: { sha: "f0" }, labels: [], user: user("drive-by") } }))
  expect(await fork.json()).toMatchObject({ reviewing: false, asked: true })
  expect(autoCalls.started).toEqual([])
  expect(autoShown.at(-1)?.kind).toBe("waiting")
  const own = await send(pullRequest("opened"))
  expect(own.status).toBe(202)
  expect(autoCalls.started.length).toBe(1)
  await web.dispose()
})

test("a delivery glance failed handling is let go, so its redelivery is acted on; a malformed one isn't", async () => {
  // the first review start finds the database down, the next one works
  let outages = 1
  const flaky = Layer.effect(
    Reviewer.Service,
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<Review>()
      return Reviewer.Service.of({
        start: () => (outages-- > 0 ? Effect.fail(new Store.StoreError({ operation: "create", message: "database down" })) : Effect.void),
        run: () => Effect.die("not in tests"),
        cancel: () => Effect.void,
        subscribe: PubSub.subscribe(changes),
      })
    }),
  )
  const web = HttpRouter.toWebHandler(
    Http.routes(config).pipe(
      Layer.provide(Layer.mergeAll(memoryStore(config), flaky, fakePanel([]), fakeCheckout, Triggers.layer(config.triggers)).pipe(Layer.provideMerge(github))),
      Layer.provide(BunServices.layer),
    ),
    { disableLogger: true },
  )
  const send = (payload: unknown, delivery: string) => {
    const body = JSON.stringify(payload)
    return web.handler(
      new Request("http://glance/api/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": delivery,
          "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
        },
      }),
    )
  }
  const labeled = pullRequest("labeled", { label: { name: "glance:high" } })
  expect((await send(labeled, "outage")).status).toBe(500)
  expect((await send(labeled, "outage")).status).toBe(202)
  expect((await send({ action: "opened" }, "malformed")).status).toBe(400)
  expect(await (await send({ action: "opened" }, "malformed")).json()).toEqual({ ok: true, duplicate: true })
  await web.dispose()
})

/** a webhook of its own: its environment, what's saved before the first delivery, and what it started and showed */
const harness = (env: Record<string, string>, seed: (store: Store.Interface) => Effect.Effect<unknown, Store.StoreError> = () => Effect.void) => {
  const own = configFrom({ GITHUB_WEBHOOK_SECRET: SECRET, ...env })
  const calls: Calls = { started: [], cancelled: [] }
  const shown: Array<{ readonly pr: PrRef; readonly kind: string }> = []
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(Http.routes(own), Layer.effectDiscard(Effect.flatMap(Store.Service, seed))).pipe(
      Layer.provide(
        Layer.mergeAll(memoryStore(own), fakeReviewer(calls), fakePanel(shown), fakeCheckout, Triggers.layer(own.triggers)).pipe(
          Layer.provideMerge(fakeGitHub([], { writer: "write", maintainer: "maintain" })),
        ),
      ),
      Layer.provide(BunServices.layer),
    ),
    { disableLogger: true },
  )
  const send = (event: string, payload: unknown) => {
    const body = JSON.stringify(payload)
    return web.handler(
      new Request("http://glance/api/webhooks/github", {
        method: "POST",
        body,
        headers: { "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}` },
      }),
    )
  }
  return { calls, shown, send, dispose: web.dispose }
}

const openedBy = (login: string, type = "User", repo = repository) =>
  pullRequest("opened", { pull_request: { draft: false, head: { sha: "b1" }, labels: [], user: user(login, type) }, repository: repo })

test("a blocked author's pull request gets no review and no comment; /glance still reviews it", async () => {
  // blocked globally from the environment, and in acme/api of its own (any case, as on github)
  const web = harness({ GLANCE_MODE: "auto", GLANCE_BLOCKED_AUTHORS: "dependabot[bot]" }, (store) =>
    store.saveRepoSettings({ ...repoSettings("acme/api"), mode: "ask", blockedAuthors: ["Renovate[bot]"] }),
  )
  const dependabot = await web.send("pull_request", openedBy("dependabot[bot]", "Bot"))
  const renovate = await web.send("pull_request", openedBy("renovate[bot]", "Bot"))
  expect(await dependabot.json()).toEqual({ ok: true, reviewing: false, blocked: "dependabot[bot]" })
  expect(await renovate.json()).toEqual({ ok: true, reviewing: false, blocked: "renovate[bot]" })
  expect(web.calls.started).toEqual([])
  expect(web.shown).toEqual([])
  // someone who may can still ask for it
  const asked = await web.send("issue_comment", comment("/glance high", "maintainer"))
  expect(asked.status).toBe(202)
  expect(web.calls.started.map((s) => s.options.trigger)).toEqual(["comment high"])
  await web.dispose()
})

test("with allowed authors, only theirs are reviewed right away in auto mode; the rest get the checkboxes", async () => {
  const web = harness({ GLANCE_MODE: "auto" }, (store) =>
    Effect.flatMap(store.settings, (settings) => store.saveSettings({ ...settings, allowedAuthors: ["Maintainer"] })),
  )
  const writer = await web.send("pull_request", openedBy("writer"))
  expect(await writer.json()).toMatchObject({ reviewing: false, asked: true })
  expect(web.shown.at(-1)?.kind).toBe("waiting")
  expect(web.calls.started).toEqual([])
  const maintainer = await web.send("pull_request", openedBy("maintainer"))
  expect(maintainer.status).toBe(202)
  expect(web.calls.started.length).toBe(1)
  await web.dispose()
})

test("a repository's own mode and depth replace the global ones; other repositories keep the global settings", async () => {
  const web = harness({ GLANCE_MODE: "ask" }, (store) => store.saveRepoSettings({ ...repoSettings("Acme/API"), mode: "auto", depth: "high" }))
  const own = await web.send("pull_request", openedBy("writer"))
  expect(own.status).toBe(202)
  expect(await own.json()).toMatchObject({ reviewing: true, depth: "high" })
  const other = await web.send("pull_request", openedBy("writer", "User", { name: "web", owner: { login: "acme" } }))
  expect(await other.json()).toMatchObject({ reviewing: false, asked: true })
  expect(web.calls.started.map((s) => s.pr.repo)).toEqual(["api"])
  await web.dispose()
})
