// mekiki resolving its own threads once their problem is fixed: the rules (plain code), then the whole
// pipeline against a local github fixture speaking rest and graphql, enterprise-style (/api/v3, /api/graphql)
import { afterAll, describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Agent } from "../src/agent.ts"
import type { Finding, Review } from "../src/domain.ts"
import { GitHub, graphqlUrl, type ReviewThread } from "../src/github.ts"
import { commentBody, fixedReply, fixedThreads, type Options, Reviewer, type StartOptions } from "../src/reviewer.ts"
import { configFrom, fakeAgent, fakeCheckout, fakePanel, memoryStore } from "./support.ts"

const finding = (overrides: Partial<Finding>): Finding => ({
  path: "src/a.ts",
  line: 5,
  severity: "high",
  category: "bug",
  title: "Null check missing",
  body: "crashes on an empty list",
  suggestion: null,
  confidence: 0.9,
  ...overrides,
})

const agentInfo = { kind: "claude", model: "", depth: "light" } as const

/** a comment in a thread: `ours` when mekiki's login wrote it */
const said = (body: string, ours: boolean, extra: Partial<ReviewThread["comments"][number]> = {}) => ({
  id: `c-${body.length}`,
  body,
  ours,
  canCollapse: ours,
  collapsed: false,
  ...extra,
})

/** a thread mekiki started on `f`, outdated and open unless said otherwise */
const thread = (id: string, f: Finding, overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  resolved: false,
  outdated: true,
  path: f.path,
  line: f.line,
  canResolve: true,
  comments: [said(commentBody(f, agentInfo), true)],
  ...overrides,
})

describe("which threads are fixed", () => {
  const reviewed = new Set(["src/a.ts"])

  test("an outdated thread of mekiki's that the review didn't find again", () => {
    const threads = [thread("t1", finding({}))]
    expect(fixedThreads(threads, { reviewed, findings: [] }).map((t) => t.id)).toEqual(["t1"])
    // a different problem elsewhere in the file doesn't keep it open
    expect(fixedThreads(threads, { reviewed, findings: [finding({ line: 60, title: "Slow loop", category: "performance" })] })).toHaveLength(1)
  })

  test("found again, the same title near the moved line or the same kind of problem on it: stays open", () => {
    const sql = finding({ line: 20, title: "SQL injection in query", category: "security" })
    const threads = [thread("t2", sql)]
    expect(fixedThreads(threads, { reviewed, findings: [finding({ line: 31, title: "SQL injection in the query builder", category: "security" })] })).toEqual(
      [],
    )
    expect(fixedThreads(threads, { reviewed, findings: [finding({ line: 22, title: "Unescaped user input", category: "security" })] })).toEqual([])
  })

  test("not outdated, already resolved or hidden, in a file this review didn't read, or reopened after mekiki resolved it: stays as it is", () => {
    const f = finding({})
    const reopened = thread("t6", f, {
      comments: [said(commentBody(f, agentInfo), true), said(fixedReply("abcdef1234"), true)],
    })
    const hidden = thread("t7", f, { comments: [said(commentBody(f, agentInfo), true, { collapsed: true })] })
    const threads = [thread("t3", f, { outdated: false }), thread("t4", f, { resolved: true }), thread("t5", finding({ path: "src/b.ts" })), reopened, hidden]
    expect(fixedThreads(threads, { reviewed, findings: [] })).toEqual([])
  })

  test("never a thread mekiki didn't start", () => {
    const f = finding({})
    const threads = [
      // someone else's, even one copying mekiki's mark
      thread("theirs", f, { comments: [said(commentBody(f, agentInfo), false)] }),
      // mekiki's login (a personal token) writing by hand: no mark
      thread("by hand", f, { comments: [said("please rename this", true)] }),
      // mekiki only replied in it
      thread("replied", f, {
        comments: [said("looks wrong", false), said(commentBody(f, agentInfo), true)],
      }),
    ]
    expect(fixedThreads(threads, { reviewed, findings: [] })).toEqual([])
  })

  test("the mark survives any title", () => {
    const tricky = finding({ title: "Closes --> the <!-- comment --> early" })
    expect(commentBody(tricky, agentInfo)).toEndWith(`<!-- mekiki:finding bug ${encodeURIComponent(tricky.title)} -->`)
    expect(fixedThreads([thread("t", tricky)], { reviewed, findings: [finding({ line: 9, title: tricky.title, category: "security" })] })).toEqual([])
  })
})

test("the graphql endpoint follows GITHUB_API_URL", () => {
  expect(graphqlUrl("https://api.github.com")).toBe("https://api.github.com/graphql")
  expect(graphqlUrl("https://ghe.acme.com/api/v3")).toBe("https://ghe.acme.com/api/graphql")
  expect(graphqlUrl("https://ghe.acme.com/api/v3/")).toBe("https://ghe.acme.com/api/graphql")
})

// ---------- the pipeline, over http ----------

const SHA = "def4567890abcdef"
const fixed = finding({})
const sql = finding({ line: 20, title: "SQL injection in query", category: "security" })
const leak = finding({ line: 40, title: "Leaks the file handle", category: "reliability" })
const mekiki = (f: Finding) => ({ id: `c-${f.line}`, body: commentBody(f, agentInfo), viewerDidAuthor: true, viewerCanMinimize: true, isMinimized: false })
const node = (id: string, f: Finding, overrides: Record<string, unknown> = {}) => ({
  id,
  isResolved: false,
  isOutdated: true,
  path: f.path,
  line: null,
  originalLine: f.line,
  viewerCanResolve: true,
  comments: { nodes: [mekiki(f)] },
  ...overrides,
})
// two pages: mekiki's fixed thread is on each
const PAGES = [
  [
    node("fixed", fixed),
    node("found-again", sql),
    node("current", leak, { isOutdated: false, line: 40 }),
    node("theirs", fixed, { comments: { nodes: [{ ...mekiki(fixed), viewerDidAuthor: false, viewerCanMinimize: false }] } }),
    node("by-hand", fixed, { comments: { nodes: [{ ...mekiki(fixed), body: "please rename this" }] } }),
  ],
  [node("done", fixed, { isResolved: true }), node("fixed-too", leak)],
]

interface Request {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly body: { readonly query?: string; readonly variables?: Record<string, unknown> } & Record<string, unknown>
}
const requests: Array<Request> = []
const graphql = () => requests.filter((r) => r.path === "/api/graphql")
const resolutions = () => graphql().filter((r) => r.body.query?.includes("resolveReviewThread"))
const collapses = () => graphql().filter((r) => r.body.query?.includes("minimizeComment"))
// pull request 4: mekiki's app may reply but not resolve (no write access to the contents)
const LOCKED = [
  node("may-hide", fixed, { viewerCanResolve: false }),
  node("may-not", leak, { viewerCanResolve: false, comments: { nodes: [{ ...mekiki(leak), viewerCanMinimize: false }] } }),
]

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = new URL(request.url).pathname
    const body = request.method === "POST" ? await request.json() : {}
    requests.push({ method: request.method, path, authorization: request.headers.get("authorization"), body })
    if (path === "/api/graphql") {
      if (body.query.includes("resolveReviewThread")) return Response.json({ data: { resolveReviewThread: { thread: { isResolved: true } } } })
      if (body.query.includes("minimizeComment")) return Response.json({ data: { minimizeComment: { minimizedComment: { isMinimized: true } } } })
      if (body.variables.number === 4)
        return Response.json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: LOCKED } } } } })
      // pull request 3: graphql is down (rate limited), the way it says so: status 200, `errors`
      if (body.variables.number === 3) return Response.json({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })
      const page = body.variables.after === null ? 0 : 1
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { pageInfo: { hasNextPage: page === 0, endCursor: page === 0 ? "cursor-1" : null }, nodes: PAGES[page] },
            },
          },
        },
      })
    }
    if (path.endsWith("/reviews")) return Response.json({ id: 1 })
    if (request.headers.get("accept")?.includes("github.diff"))
      return new Response("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -22,3 +22,3 @@\n context\n-old\n+new\n context\n")
    if (path.includes("/pulls/"))
      return Response.json({ title: "fixes", body: "", state: "open", draft: false, html_url: "https://github.com/acme/api/pull/1", head: { sha: SHA } })
    return new Response("not here", { status: 404 })
  },
})
afterAll(() => server.stop(true))

// the agent still sees the sql injection, under another title, a few lines further down
const agent = Layer.effect(
  Agent.Service,
  Effect.map(Agent.Service, (fake) =>
    Agent.Service.of({
      ...fake,
      review: () =>
        Effect.succeed({
          review: { summary: "Looked.", findings: [finding({ line: 24, title: "SQL injection in the query builder", category: "security" })] },
          usage: undefined,
        }),
    }),
  ),
).pipe(Layer.provide(fakeAgent))

const review = (number: number, start: StartOptions, env: Record<string, string> = {}) => {
  const config = configFrom({ GITHUB_API_URL: `${server.url.href}api/v3`, GITHUB_TOKEN: "fixture-token", ...env })
  const options: Options = { resolveFixed: config.github.resolveFixed }
  requests.length = 0
  return Effect.runPromise(
    Effect.flatMap(Reviewer.Service, (reviewer) => reviewer.run({ owner: "acme", repo: "api", number }, start)).pipe(
      Effect.scoped,
      Effect.provide(Reviewer.layer(config.limits, options)),
      Effect.provide(Layer.mergeAll(GitHub.layer(config.github), agent, fakePanel([]), fakeCheckout).pipe(Layer.provideMerge(memoryStore(config)))),
      Effect.provide(BunServices.layer),
    ),
  )
}

describe("after a review", () => {
  test("mekiki's outdated threads it didn't find again are resolved, every page read; nothing else is touched", async () => {
    const done: Review = await review(1, { trigger: "manual" })
    expect(done.status).toBe("done")
    expect(done.posted).toBe(true)
    expect(done.steps.map((s) => s.name)).toContain("resolve")
    // two pages of threads, then one call per fixed thread: a reply and the resolution together
    expect(
      graphql()
        .filter((r) => r.body.query?.includes("reviewThreads"))
        .map((r) => r.body.variables?.after),
    ).toEqual([null, "cursor-1"])
    expect(resolutions().map((r) => r.body.variables?.thread)).toEqual(["fixed", "fixed-too"])
    expect(resolutions()[0]?.body.query).toContain("addPullRequestReviewThreadReply")
    expect(resolutions()[0]?.body.variables?.body).toBe(fixedReply(SHA))
    expect(fixedReply(SHA)).toStartWith("✅ Fixed in def4567:")
    // the same token as the rest calls
    expect(graphql().every((r) => r.method === "POST" && r.authorization === "Bearer fixture-token")).toBe(true)
    // the inline comment it posted carries the mark that finds it again
    const posted = requests.find((r) => r.path.endsWith("/reviews"))?.body
    expect(JSON.stringify(posted)).toContain("<!-- mekiki:finding security SQL%20injection%20in%20the%20query%20builder -->")
  })

  test("a dry run, a review that posts nothing, or MEKIKI_RESOLVE_FIXED=false resolves nothing", async () => {
    for (const [start, env] of [
      [{ trigger: "manual", dryRun: true }, {}],
      [{ trigger: "manual", overrides: { postComments: false } }, {}],
      [{ trigger: "manual" }, { MEKIKI_RESOLVE_FIXED: "false" }],
    ] as const) {
      const done = await review(2, start, env)
      expect(done.status).toBe("done")
      expect(graphql()).toEqual([])
    }
  })

  test("graphql failing doesn't fail the review", async () => {
    const done = await review(3, { trigger: "manual" })
    expect(done.status).toBe("done")
    expect(done.posted).toBe(true)
    expect(done.error).toBeNull()
    expect(graphql()).toHaveLength(1)
    expect(resolutions()).toEqual([])
  })

  test("where github won't let mekiki resolve, it hides its own fixed comment as outdated; where it can't do that either, it leaves the thread be", async () => {
    const done = await review(4, { trigger: "manual" })
    expect(done.status).toBe("done")
    expect(resolutions()).toEqual([])
    expect(collapses().map((r) => [r.body.variables?.thread, r.body.variables?.comment])).toEqual([["may-hide", `c-${fixed.line}`]])
    expect(collapses()[0]?.body.query).toContain("classifier: OUTDATED")
    // no "fixed" reply on a thread mekiki can't close
    expect(graphql().filter((r) => r.body.variables?.thread === "may-not")).toEqual([])
  })
})
