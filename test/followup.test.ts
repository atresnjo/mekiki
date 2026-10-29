// a review after the first: a push is reviewed as what was pushed since, and quietly skipped when
// that's nothing to read (screenshots). someone asking, or asking for another depth, gets the whole pull request
import { afterAll, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Agent } from "../src/agent.ts"
import { GitHub } from "../src/github.ts"
import { Reviewer, type StartOptions } from "../src/reviewer.ts"
import { Store } from "../src/store.ts"
import { configFrom, fakeAgent, fakeCheckout, fakePanel, memoryStore, review as stored } from "./support.ts"

const OLD = "aaa1111111111111"
const NEW = "bbb2222222222222"
const code = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n context\n-old\n+new\n context\n"
const screenshot =
  "diff --git a/docs/shot.png b/docs/shot.png\nnew file mode 100644\nindex 0000000..1234567\nBinary files /dev/null and b/docs/shot.png differ\n"
const more = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n context\n-new\n+newer\n context\n"

// pull request 1: the push since the last review was a screenshot. pull request 2: it was code
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname
    const number = Number(path.match(/\/pulls\/(\d+)/)?.[1] ?? 0)
    if (path.includes("/compare/")) return new Response(path.includes("/pr-two/") ? more : screenshot)
    if (path.endsWith("/reviews")) return Response.json({ id: 1 })
    if (request.headers.get("accept")?.includes("github.diff")) return new Response(code + screenshot)
    if (number)
      return Response.json({ title: "change", body: "", state: "open", draft: false, html_url: `https://github.com/acme/x/pull/${number}`, head: { sha: NEW } })
    return new Response("not here", { status: 404 })
  },
})
afterAll(() => server.stop(true))

/** every file an agent was given, per call */
const reviewed: Array<string> = []
const agent = Layer.effect(
  Agent.Service,
  Effect.map(Agent.Service, (fake) =>
    Agent.Service.of({
      ...fake,
      review: (request) =>
        Effect.sync(() => {
          reviewed.push(...[...request.prompt.matchAll(/^### (\S+)/gm)].map((m) => m[1] ?? ""))
          return { summary: "Looked.", findings: [] }
        }),
    }),
  ),
).pipe(Layer.provide(fakeAgent))

/** pull request `number` of acme/`repo` was last reviewed at OLD, light */
const followUp = (repo: string, start: StartOptions) => {
  const config = configFrom({ GITHUB_API_URL: server.url.href.replace(/\/$/, ""), GITHUB_TOKEN: "fixture-token" })
  reviewed.length = 0
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store.Service
      yield* store.create(stored({ repo: `acme/${repo}`, number: 1, headSha: OLD, depth: "light", status: "done" }))
      const reviewer = yield* Reviewer.Service
      return yield* reviewer.run({ owner: "acme", repo, number: 1 }, start)
    }).pipe(
      Effect.scoped,
      Effect.provide(Reviewer.layer(config.limits, { resolveFixed: false })),
      Effect.provide(Layer.mergeAll(GitHub.layer(config.github), agent, fakePanel([]), fakeCheckout).pipe(Layer.provideMerge(memoryStore(config)))),
      Effect.provide(BunServices.layer),
    ),
  )
}

test("a push of nothing to read is skipped, and says what it was", async () => {
  const done = await followUp("pr-one", { trigger: "synchronize", automatic: true })
  expect(done.status).toBe("skipped")
  expect(done.summary).toBe("nothing to review since the last review: 1 binary")
  expect(done.skippedFiles).toBe(1)
  expect(reviewed).toEqual([])
})

test("asking for another depth reviews the whole pull request, not just the push", async () => {
  const done = await followUp("pr-one", { trigger: "checkbox high", overrides: { depth: "high" } })
  expect(done.status).toBe("done")
  expect(done.incremental).toBe(false)
  expect(reviewed).toEqual(["src/a.ts"])
})

test("asking again at the same depth, with nothing new to read, reviews the whole pull request", async () => {
  const done = await followUp("pr-one", { trigger: "comment" })
  expect(done.status).toBe("done")
  expect(done.incremental).toBe(false)
  expect(reviewed).toEqual(["src/a.ts"])
})

test("a push of code is reviewed as just what was pushed", async () => {
  const done = await followUp("pr-two", { trigger: "synchronize", automatic: true })
  expect(done.status).toBe("done")
  expect(done.incremental).toBe(true)
  expect(reviewed).toEqual(["src/a.ts"])
})
