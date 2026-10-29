// the api agent, end to end against the AI SDK's mock model: it reads the checkout through the
// sandbox, answers in the review schema, keeps to its step cap and its time, stops when the review
// does, counts what it spent, and its key reaches no child process, no rpc answer and no error
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider"
import { MockLanguageModelV4 } from "ai/test"
import { Effect, Fiber, Layer, Option, Redacted, Schema } from "effect"
import { RpcTest } from "effect/rpc"
import { Agent } from "../src/agent.ts"
import { AgentError, type ChunkReview, Review } from "../src/domain.ts"
import { GitHub } from "../src/github.ts"
import { Health } from "../src/health.ts"
import { estimate } from "../src/prices.ts"
import { system } from "../src/prompt.ts"
import { Reviewer } from "../src/reviewer.ts"
import { AuthenticatedLive, HandlersLive } from "../src/rpc-server.ts"
import { GlanceRpcs } from "../src/rpc.ts"
import { Store } from "../src/store.ts"
import { Checkout } from "../src/checkout.ts"
import { type Calls, configFrom, fakeAuth, fakeGitHub, fakePanel, fakeReviewer, fakeUsage, memoryStore, review as stored } from "./support.ts"

const KEY = "sk-test-NEVER-SHOWN-4f2a"
const root = mkdtempSync(join(tmpdir(), "glance-api-"))
const code = join(root, "checkout")
mkdirSync(join(code, "src"), { recursive: true })
writeFileSync(join(root, "secret.txt"), "OUTSIDE-SECRET\n")
writeFileSync(join(code, "src", "a.ts"), "export const add = (a: number, b: number) => a - b\n")
afterAll(() => rmSync(root, { recursive: true, force: true }))

const tokens = (input: number, cached: number, output: number) => ({
  inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
})
const toolCall = (toolName: string, input: unknown): LanguageModelV4GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage: tokens(1000, 200, 50),
  warnings: [],
})
const answer = (review: unknown): LanguageModelV4GenerateResult => ({
  content: [{ type: "text", text: JSON.stringify(review) }],
  finishReason: { unified: "stop", raw: undefined },
  usage: tokens(3000, 1000, 400),
  warnings: [],
})
const finding = {
  path: "src/a.ts",
  line: 1,
  severity: "high",
  category: "bug",
  title: "add subtracts",
  body: "a - b for add.",
  suggestion: null,
  confidence: 0.9,
}
const REVIEW: ChunkReview = { summary: "Changes add; it subtracts.", findings: [finding] } as ChunkReview

const api = (overrides: Partial<Agent.ApiOptions> = {}): Agent.ApiOptions => ({
  provider: Option.some("anthropic"),
  model: "claude-sonnet-5-5",
  models: ["claude-haiku-5-5"],
  baseUrl: Option.none(),
  key: Option.some(Redacted.make(KEY)),
  maxSteps: 4,
  ...overrides,
})

/** the agent on `model`, every model asked for recorded */
const withAgent = <A, E>(
  model: MockLanguageModelV4,
  f: (agent: Agent.Interface) => Effect.Effect<A, E>,
  options: { api?: Partial<Agent.ApiOptions>; timeout?: number } = {},
) => {
  const asked: Array<string> = []
  return Effect.runPromise(
    Agent.make({ claudeBin: "/nonexistent/claude", codexBin: "/nonexistent/codex", timeout: options.timeout ?? 10, api: api(options.api) }, (id) => {
      asked.push(id)
      return model
    }).pipe(
      Effect.flatMap(f),
      Effect.map((result) => ({ result, asked })),
      Effect.provide(BunServices.layer),
    ),
  )
}

const request = (withCode: boolean, effort: "low" | "medium" | "high" = "high") => ({
  agent: "api" as const,
  model: "",
  effort,
  system: system(withCode),
  prompt: "## Diff\n### src/a.ts\n1 + export const add = (a: number, b: number) => a - b",
  code: withCode ? code : undefined,
})

/** the text of every tool result the model was shown, in the call */
const toolResults = (call: LanguageModelV4CallOptions | undefined) =>
  JSON.stringify((call?.prompt ?? []).filter((m) => m.role === "tool").map((m) => m.content))

describe("the api agent", () => {
  test("reads the checkout with its tools, then answers in the review schema; what it spent is counted", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall("read_file", { path: "src/a.ts" }), toolCall("read_file", { path: "../secret.txt" }), answer(REVIEW)],
    })
    const { result, asked } = await withAgent(model, (agent) => agent.review(request(true)))
    expect(result.review).toEqual(REVIEW)
    // the default model is GLANCE_API_MODEL's
    expect(asked).toEqual(["claude-sonnet-5-5"])

    const [first, , last] = model.doGenerateCalls
    expect(first?.prompt[0]).toEqual({ role: "system", content: system(true) })
    expect(first?.reasoning).toBe("high")
    expect(first?.tools?.map((t) => t.name).sort()).toEqual(["list_files", "read_file", "search"])
    expect(first?.responseFormat?.type).toBe("json")
    // what it read came back to it; what was outside the checkout didn't
    const shown = toolResults(last)
    expect(shown).toContain("a - b")
    expect(shown).toContain("isn't allowed")
    expect(shown).not.toContain("OUTSIDE-SECRET")

    const spent = { inputTokens: 5000, cachedInputTokens: 1400, outputTokens: 500 }
    expect(result.usage).toEqual({ calls: 3, ...spent, costUsd: estimate("claude-sonnet-5-5", spent) })
    expect(result.usage?.costUsd).toBeCloseTo((3600 * 2 + 1400 * 0.2 + 500 * 10) / 1e6, 10)
  })

  test("with the diff alone it's offered no tools, and answers in one call", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [answer(REVIEW)] })
    const { result } = await withAgent(model, (agent) => agent.review({ ...request(false, "low"), model: "claude-haiku-5-5" }))
    expect(result.review).toEqual(REVIEW)
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(model.doGenerateCalls[0]?.tools ?? []).toEqual([])
    expect(model.doGenerateCalls[0]?.reasoning).toBe("low")
    expect(result.usage?.calls).toBe(1)
  })

  test("the step cap: the last step gets no tools, so it has to answer", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => ((options.tools ?? []).length > 0 ? toolCall("list_files", {}) : answer(REVIEW)),
    })
    const { result } = await withAgent(model, (agent) => agent.review(request(true)), { api: { maxSteps: 3 } })
    expect(result.review).toEqual(REVIEW)
    expect(model.doGenerateCalls.map((c) => (c.tools ?? []).length)).toEqual([3, 3, 0])
  })

  test("a model that never answers fails after the cap, and what it spent is still counted", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => toolCall("list_files", {}) })
    const { result } = await withAgent(model, (agent) => agent.review(request(true)).pipe(Effect.flip), { api: { maxSteps: 2 } })
    expect(result).toBeInstanceOf(AgentError)
    // the cap held: the last call it got had no tools to call
    expect(model.doGenerateCalls.map((c) => (c.tools ?? []).length)).toEqual([3, 0])
    expect(result.usage?.calls).toBe(model.doGenerateCalls.length)
  })

  test("an answer outside the schema is the same AgentError the CLIs give, with its usage", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [answer({ summary: 1, findings: "none" })] })
    const { result } = await withAgent(model, (agent) => agent.review(request(false)).pipe(Effect.flip))
    expect(result._tag).toBe("AgentError")
    expect(result.agent).toBe("api")
    expect(result.message).toContain("no valid review")
    expect(result.usage?.calls).toBe(1)
  })

  test("a review called off aborts the request", async () => {
    let aborted: Promise<boolean> = Promise.resolve(false)
    let started: () => void = () => {}
    const asked = new Promise<void>((resolve) => (started = resolve))
    const model = new MockLanguageModelV4({
      doGenerate: (options) => {
        aborted = new Promise((resolve) => options.abortSignal?.addEventListener("abort", () => resolve(true)))
        started()
        return new Promise(() => {})
      },
    })
    await withAgent(model, (agent) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(agent.review(request(true)))
        yield* Effect.promise(() => asked)
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(await aborted).toBe(true)
  })

  test("past the timeout it gives up, and the request is aborted", async () => {
    let signal: AbortSignal | undefined
    const model = new MockLanguageModelV4({
      doGenerate: (options) => {
        signal = options.abortSignal
        return new Promise(() => {})
      },
    })
    const { result } = await withAgent(model, (agent) => agent.review(request(false)).pipe(Effect.flip), { timeout: 1 })
    expect(result.message).toBe("timed out after 1s")
    expect(signal?.aborted).toBe(true)
  })

  test("a provider error never carries the key", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error(`401: invalid x-api-key ${KEY}`)
      },
    })
    const { result } = await withAgent(model, (agent) => agent.review(request(false)).pipe(Effect.flip))
    expect(result.message).not.toContain(KEY)
    expect(result.message).toContain("[redacted]")
  })

  test("ready once it has a provider, a model and that provider's key; its models are the configured one and the list", async () => {
    const model = new MockLanguageModelV4()
    const ready = await withAgent(model, (agent) => Effect.all([agent.check("api"), agent.models("api")]))
    expect(ready.result).toEqual([
      "anthropic claude-sonnet-5-5",
      [
        { id: "", label: "Default (claude-sonnet-5-5)" },
        { id: "claude-haiku-5-5", label: "claude-haiku-5-5" },
      ],
    ])
    const why = (overrides: Partial<Agent.ApiOptions>) =>
      withAgent(model, (agent) => agent.check("api").pipe(Effect.flip), { api: overrides }).then(({ result }) => result.message)
    expect(await why({ provider: Option.none() })).toContain("set GLANCE_API_PROVIDER")
    expect(await why({ model: "" })).toBe("set GLANCE_API_MODEL")
    expect(await why({ key: Option.none() })).toBe("set ANTHROPIC_API_KEY")
    expect(await why({ provider: Option.some("google"), key: Option.none() })).toBe("set GOOGLE_GENERATIVE_AI_API_KEY")
  })
})

describe("providers and prices", () => {
  test("each provider gets its own model; a gateway is spoken to over chat completions", () => {
    const at = (provider: Agent.Provider, baseUrl?: string) => {
      const model = Agent.connect(api({ provider: Option.some(provider), baseUrl: Option.fromUndefinedOr(baseUrl) }))("some-model")
      return typeof model === "string" ? model : `${model.provider} ${model.modelId}`
    }
    expect(at("openai")).toBe("openai.responses some-model")
    expect(at("openai", "https://openrouter.ai/api/v1")).toBe("openai.chat some-model")
    expect(at("anthropic")).toBe("anthropic.messages some-model")
    expect(at("google")).toBe("google.generative-ai some-model")
  })

  test("a gateway's or a snapshot's name finds its price; GLANCE_PRICES adds and replaces entries", () => {
    const tokens = { inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000 }
    // 1M fresh at $2, 1M cached at $0.20, 1M out at $10
    for (const name of ["claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", "claude-sonnet-5-5-20260901"]) expect(estimate(name, tokens)).toBeCloseTo(12.2, 6)
    expect(estimate("gpt-6-sol-2026-09-01", tokens)).toBeCloseTo(2 + 0.1 + 10, 6)
    expect(estimate("unknown-model", tokens)).toBeNull()
    const { prices } = configFrom({
      GLANCE_PRICES: JSON.stringify({ "my-model": { input: 1, cachedInput: 0, output: 1 }, "claude-sonnet-5-5": { input: 0, cachedInput: 0, output: 0 } }),
    }).agent
    expect(estimate("my-model", tokens, prices)).toBeCloseTo(2, 6)
    expect(estimate("claude-sonnet-5-5", tokens, prices)).toBe(0)
    expect(estimate("claude-opus-5-5", tokens, prices)).toBeCloseTo(4 + 0.2 + 20, 6)
    expect(() => configFrom({ GLANCE_PRICES: "{not json" })).toThrow()
  })
})

describe("the key stays on the server", () => {
  test("the CLIs never get it, nor any other api setting, and their usage is recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glance-cli-env-"))
    const saved = { ...process.env }
    Object.assign(process.env, {
      CLAUDE_CONFIG_DIR: dir,
      CODEX_HOME: dir,
      OPENAI_API_KEY: KEY,
      ANTHROPIC_API_KEY: KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: KEY,
      GLANCE_API_BASE_URL: "https://gateway.example",
      GLANCE_PRICES: "{}",
    })
    try {
      const config = configFrom({
        CLAUDE_BIN: resolve("test/e2e/agent.ts"),
        CODEX_BIN: resolve("test/e2e/agent.ts"),
        GLANCE_API_PROVIDER: "openai",
        GLANCE_API_MODEL: "gpt-6-sol",
        OPENAI_API_KEY: KEY,
      })
      const answers = await Effect.runPromise(
        Agent.make(config.agent).pipe(
          Effect.flatMap((agent) =>
            Effect.all([
              agent.review({ ...request(true), agent: "claude", model: "sonnet" }),
              agent.review({ ...request(true), agent: "codex", model: "gpt-6-sol" }),
            ]),
          ),
          Effect.provide(BunServices.layer),
        ),
      )
      const calls = readFileSync(join(dir, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(calls).toHaveLength(2)
      for (const call of calls) expect(call.leaked).toEqual([])
      expect(JSON.stringify(calls)).not.toContain(KEY)
      // claude code reports its own cost; codex's tokens are priced from the table
      expect(answers[0].usage).toEqual({ calls: 1, inputTokens: 6000, cachedInputTokens: 4500, outputTokens: 800, costUsd: 0.0123 })
      const codex = { inputTokens: 9000, cachedInputTokens: 6000, outputTokens: 700 }
      expect(answers[1].usage).toEqual({ calls: 1, ...codex, costUsd: estimate("gpt-6-sol", codex) })
    } finally {
      process.env = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("no rpc answer holds it: status, models and settings name the provider and model at most", async () => {
    const config = configFrom({
      CLAUDE_BIN: "/nonexistent/claude",
      CODEX_BIN: "/nonexistent/codex",
      GLANCE_API_PROVIDER: "openai",
      GLANCE_API_MODEL: "gpt-6-sol",
      GLANCE_API_MODELS: "gpt-6-luna",
      GLANCE_API_BASE_URL: "https://gateway.example/v1",
      OPENAI_API_KEY: KEY,
      GLANCE_AGENT: "api",
    })
    // the config itself prints the key redacted, should anything log it
    expect(JSON.stringify(config)).not.toContain(KEY)
    expect(String(Option.getOrUndefined(config.agent.api.key))).not.toContain(KEY)
    const calls: Calls = { started: [], cancelled: [] }
    const services = Layer.mergeAll(fakeAuth(false), fakeReviewer(calls), fakeUsage, fakeGitHub([])).pipe(
      Layer.provideMerge(Health.layer.pipe(Layer.provideMerge(Layer.mergeAll(Agent.layer(config.agent), memoryStore(config))))),
      Layer.provideMerge(BunServices.layer),
    )
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(GlanceRpcs)
        const status = yield* client.GetStatus(undefined)
        const models = yield* client.GetModels(undefined)
        const settings = yield* client.GetSettings(undefined)
        const saved = yield* client.SaveSettings({ ...settings, model: "gpt-6-luna" })
        const refused = yield* client.SaveSettings({ ...settings, model: "gpt-1" }).pipe(Effect.flip)
        return { status, models, settings, saved, refused }
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(HandlersLive(config), AuthenticatedLive).pipe(Layer.provideMerge(services)))),
    )
    expect(answers.status.agents.api).toBe("openai gpt-6-sol")
    expect(answers.models.api).toEqual([
      { id: "", label: "Default (gpt-6-sol)" },
      { id: "gpt-6-luna", label: "gpt-6-luna" },
    ])
    expect(answers.settings.agent).toBe("api")
    expect(answers.saved.model).toBe("gpt-6-luna")
    expect(answers.refused._tag).toBe("Invalid")
    const text = JSON.stringify(answers)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain("gateway.example")
  })
})

describe("usage on the review", () => {
  const diff = (file: string) =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+export const add = (a: number, b: number) => a - b\n`
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname
      if (request.headers.get("accept")?.includes("github.diff")) return new Response(diff("src/a.ts") + diff("src/b.ts"))
      if (path.includes("/pulls/"))
        return Response.json({ title: "add", body: "", state: "open", draft: false, html_url: "https://github.com/acme/api/pull/1", head: { sha: "abc" } })
      return new Response("not here", { status: 404 })
    },
  })
  afterAll(() => server.stop(true))

  test("every chunk's spend is summed into the review and kept, a failed chunk's too", async () => {
    // two chunks: src/a.ts reads the file and answers, src/b.ts answers outside the schema
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const prompt = JSON.stringify(options.prompt)
        if (prompt.includes("### src/b.ts")) return answer({ nope: true })
        return options.prompt.some((m) => m.role === "tool") ? answer(REVIEW) : toolCall("read_file", { path: "src/a.ts" })
      },
    })
    const config = configFrom({
      GITHUB_API_URL: server.url.href.replace(/\/$/, ""),
      GITHUB_TOKEN: "fixture-token",
      CHUNK_CHARS: "1",
      GLANCE_API_PROVIDER: "anthropic",
      GLANCE_API_MODEL: "claude-sonnet-5-5",
      ANTHROPIC_API_KEY: KEY,
      GLANCE_AGENT: "api",
    })
    const checkout = Layer.succeed(Checkout.Service, Checkout.Service.of({ at: () => Effect.succeed(code) }))
    const { review, kept } = await Effect.runPromise(
      Effect.gen(function* () {
        const review = yield* Reviewer.Service.use((reviewer) => reviewer.run({ owner: "acme", repo: "api", number: 1 }, { trigger: "test", dryRun: true }))
        const kept = yield* Store.Service.use((store) => store.get(review.id))
        return { review, kept: Option.getOrUndefined(kept) }
      }).pipe(
        Effect.scoped,
        Effect.provide(Reviewer.layer(config.limits, { resolveFixed: false })),
        Effect.provide(
          Layer.mergeAll(
            GitHub.layer(config.github),
            Agent.layer(config.agent, () => model),
            fakePanel([]),
            checkout,
          ).pipe(Layer.provideMerge(memoryStore(config))),
        ),
        Effect.provide(BunServices.layer),
      ),
    )
    expect(review.status).toBe("done")
    expect(review.agent).toBe("api")
    expect(review.unreviewed).toEqual(["src/b.ts"])
    expect(review.findings.map((f) => f.title)).toEqual(["add subtracts"])
    // a.ts: a read (1000 in, 200 cached, 50 out), then the answer (3000, 1000, 400); b.ts: one bad answer (3000, 1000, 400)
    const spent = { inputTokens: 7000, cachedInputTokens: 2200, outputTokens: 850 }
    expect(review.usage).toEqual({ calls: 3, ...spent, costUsd: estimate("claude-sonnet-5-5", spent) })
    expect(kept?.usage).toEqual(review.usage)
    console.log(`sample review against the mock model: ${JSON.stringify(review.usage)}`)
  })

  test("a review saved before usage was kept reads back with none", () => {
    const { usage: _, ...old } = { ...stored(), id: 1 }
    expect(Effect.runSync(Schema.decodeUnknownEffect(Review)(old)).usage).toBeNull()
  })
})
