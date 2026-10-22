import { afterAll, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import type { PrRef } from "../src/domain.ts"
import * as Http from "../src/http.ts"
import { type Calls, configFrom, fakeCheckout, fakeGitHub, fakePanel, fakeReviewer, memoryStore } from "./support.ts"

const SECRET = "whsec"
const config = configFrom({ GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_WEBHOOK_MAX_BYTES: "10000" })
const calls: Calls = { started: [], cancelled: [] }
const acknowledged: Array<number> = []
const shown: Array<{ readonly pr: PrRef; readonly kind: string }> = []

const { handler, dispose } = HttpRouter.toWebHandler(
  Http.routes(config).pipe(
    Layer.provide(Layer.mergeAll(memoryStore(config), fakeReviewer(calls), fakeGitHub(acknowledged), fakePanel(shown), fakeCheckout)),
    Layer.provide(BunServices.layer),
  ),
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
const pullRequest = (action: string, extra: object = {}) => ({
  action,
  number: 7,
  pull_request: { draft: false, head: { sha: "abc" }, labels: [] },
  repository,
  ...extra,
})

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
  const response = await deliver("issue_comment", {
    action: "created",
    issue: { number: 7, pull_request: {} },
    comment: { id: 42, body: "/glance high please", user: { type: "User" } },
    repository,
  })
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
