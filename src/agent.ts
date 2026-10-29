// the reviewers: `claude -p` and `codex exec`, each running on its own subscription login, and
// `api`: a model on an API key (openai, anthropic, google or an openai-compatible gateway) through
// the AI SDK, reading the checkout with glance's own read-only tools (sandbox.ts).
// a cli call is one short-lived process with no MCP servers, no project context and our own short
// system prompt; an api call is one generateText loop. either way: a single structured answer
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import {
  APICallError,
  generateText,
  isStepCount,
  jsonSchema,
  type JSONSchema7,
  type LanguageModel,
  type LanguageModelUsage,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  tool,
} from "ai"
import { Context, Duration, Effect, FileSystem, Layer, Option, Redacted, Result, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { AgentError, type AgentKind, ChunkReview, type Usage } from "./domain.ts"
import { estimate, PRICES, type Prices } from "./prices.ts"
import { Sandbox } from "./sandbox.ts"

export interface Request {
  readonly agent: AgentKind
  /** empty: the CLI's default model */
  readonly model: string
  readonly effort: "low" | "medium" | "high"
  readonly system: string
  readonly prompt: string
  /** the repository, checked out: the agent may read it (and nothing else). none: the diff alone */
  readonly code?: string | undefined
}

/** what one call answered, and what it spent: undefined when the cli didn't say */
export interface Answer {
  readonly review: ChunkReview
  readonly usage: Usage | undefined
}

export interface Interface {
  readonly review: (request: Request) => Effect.Effect<Answer, AgentError>
  /** the CLI's version (the api agent: its provider and model), or why it can't run */
  readonly check: (agent: AgentKind) => Effect.Effect<string, AgentError>
  /** the models a review can pick: an empty id is the CLI's default */
  readonly models: (agent: AgentKind) => Effect.Effect<ReadonlyArray<Model>, AgentError>
}

export interface Model {
  readonly id: string
  readonly label: string
}

// claude code has no catalog to ask: its aliases always resolve to the newest model of each family
const CLAUDE_MODELS: ReadonlyArray<Model> = [
  { id: "", label: "Default" },
  { id: "fable", label: "Fable" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
]

/** `codex debug models`: the catalog the codex cli itself offers */
const CodexCatalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      display_name: Schema.optional(Schema.String),
      visibility: Schema.optional(Schema.String),
      priority: Schema.optional(Schema.Finite),
    }),
  ),
})
const decodeCodexCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexCatalog))

export class Service extends Context.Service<Service, Interface>()("glance/Agent") {}

export const PROVIDERS = ["openai", "anthropic", "google"] as const
export type Provider = (typeof PROVIDERS)[number]

/** where each provider's key is read from */
export const KEY_VAR: Record<Provider, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GOOGLE_GENERATIVE_AI_API_KEY" }

/** the api agent: none of it leaves the server (not to the dashboard, the database, the log or a child process) */
export interface ApiOptions {
  readonly provider: Option.Option<Provider>
  /** what a review with the default model runs on */
  readonly model: string
  /** more the dashboard may pick */
  readonly models: ReadonlyArray<string>
  /** an openai-compatible gateway (openrouter, litellm, azure): spoken to over chat completions */
  readonly baseUrl: Option.Option<string>
  readonly key: Option.Option<Redacted.Redacted>
  /** model calls one review chunk may make: the last one gets no tools, so it answers */
  readonly maxSteps: number
}

export interface Options {
  readonly claudeBin: string
  readonly codexBin: string
  readonly timeout: number
  readonly api: ApiOptions
  /** dollars per million tokens, for the estimate */
  readonly prices?: Prices | undefined
}

/**
 * what a child process (an agent cli, git, tar) is given of glance's environment: an allowlist, so
 * nothing glance holds (the database url, github's credentials, better auth's secret) reaches a
 * process that reads untrusted code. API keys aren't on it either: a key beats the subscription
 * login in both CLIs, and reviews always bill the subscription
 */
const SYSTEM = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TZ", "TERM"]
const NETWORK = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]
/** where each cli keeps its login and settings: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is the login itself */
const AGENTS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]

const allowed = new Set([...SYSTEM, ...NETWORK])
const pick = (from: Record<string, string | undefined>, keep: (key: string) => boolean) => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(from)) if (value !== undefined && keep(key)) env[key] = value
  return env
}

/** what any child process gets: the allowed part of `from` (glance's own environment by default), with `extra` on top */
export const childEnv = (extra: Record<string, string> = {}, from: Record<string, string | undefined> = process.env): Record<string, string> => ({
  ...pick(from, (key) => allowed.has(key) || key.startsWith("LC_")),
  ...extra,
})

/** what an agent cli gets: that, and its own login */
export const agentEnv = (from: Record<string, string | undefined> = process.env): Record<string, string> => ({
  ...childEnv({}, from),
  ...pick(from, (key) => AGENTS.includes(key)),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  NO_COLOR: "1",
})

/** closed objects: what both CLIs, and openai's strict structured output, accept */
const close = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(close)
  if (node === null || typeof node !== "object") return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) out[key] = close(value)
  if (out.type === "object") out.additionalProperties = false
  return out
}

/** the output schema both CLIs are handed: every key required */
const reviewJsonSchema = JSON.stringify(close(Schema.toJsonSchemaDocument(ChunkReview).schema))

/** an effect schema as the AI SDK takes one: its json schema for the model, and the schema itself to check what comes back */
const sdkSchema = <S extends Schema.Codec<unknown, unknown>>(schema: S, closed: boolean) => {
  const decode = Schema.decodeUnknownResult(schema)
  const document = Schema.toJsonSchemaDocument(schema).schema
  return jsonSchema<S["Type"]>((closed ? close(document) : document) as JSONSchema7, {
    validate: (value) => {
      const decoded = decode(value)
      return Result.isSuccess(decoded) ? { success: true, value: decoded.success } : { success: false, error: new Error(decoded.failure.message) }
    },
  })
}

const ClaudeEnvelope = Schema.Struct({
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.String),
  structured_output: Schema.optional(Schema.Unknown),
  // read on their own: a change in how claude reports them mustn't fail the review
  usage: Schema.optional(Schema.Unknown),
  total_cost_usd: Schema.optional(Schema.Unknown),
})

/** claude's input_tokens leave out what was read from and written to the cache */
const ClaudeUsage = Schema.Struct({
  input_tokens: Schema.Finite,
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  output_tokens: Schema.Finite,
})
const decodeClaudeUsage = Schema.decodeUnknownOption(ClaudeUsage)
const decodeCost = Schema.decodeUnknownOption(Schema.Finite)

/** `codex exec --json`: one event a line, and each finished turn says what it spent */
const CodexTurn = Schema.Struct({
  type: Schema.Literal("turn.completed"),
  usage: Schema.Struct({ input_tokens: Schema.Finite, cached_input_tokens: Schema.optional(Schema.Finite), output_tokens: Schema.Finite }),
})
const decodeCodexTurn = Schema.decodeUnknownOption(Schema.fromJsonString(CodexTurn))

/** the tools' inputs: what the model sends is decoded with these before anything is read */
const ReadInput = Schema.Struct({
  path: Schema.String.annotate({ description: "relative to the repository root" }),
  startLine: Schema.optional(Schema.Int).annotate({ description: "first line to read, 1-based" }),
  endLine: Schema.optional(Schema.Int).annotate({ description: "last line to read, inclusive" }),
})
const SearchInput = Schema.Struct({
  pattern: Schema.String.annotate({ description: "plain text to find (not a regular expression)" }),
  path: Schema.optional(Schema.String).annotate({ description: "a directory or file to search in, relative to the repository root; default: all of it" }),
  glob: Schema.optional(Schema.String).annotate({ description: "only files matching this, e.g. *.ts or src/**/*.py" }),
  ignoreCase: Schema.optional(Schema.Boolean),
})
const ListInput = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({ description: "a directory, relative to the repository root; default: the root" }),
  glob: Schema.optional(Schema.String).annotate({ description: "only files matching this, e.g. **/*.go" }),
})

const decodeClaudeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeEnvelope))
const decodeReview = Schema.decodeUnknownEffect(ChunkReview)
const decodeReviewJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ChunkReview))

/** the model a provider serves: a gateway speaks chat completions, which every openai-compatible server has */
export const connect =
  (api: ApiOptions) =>
  (model: string): LanguageModel => {
    const apiKey = Option.match(api.key, { onNone: () => "", onSome: Redacted.value })
    const baseURL = Option.getOrUndefined(api.baseUrl)
    const provider = Option.getOrElse(api.provider, () => "openai" as const)
    if (provider === "anthropic") return createAnthropic({ apiKey, baseURL })(model)
    if (provider === "google") return createGoogleGenerativeAI({ apiKey, baseURL })(model)
    const openai = createOpenAI({ apiKey, baseURL })
    return baseURL ? openai.chat(model) : openai(model)
  }

const tokens = (usage: LanguageModelUsage) => ({
  inputTokens: usage.inputTokens ?? 0,
  cachedInputTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
  outputTokens: usage.outputTokens ?? 0,
})

/** the api agent's tools, on a review's checkout: each answer is text, a refusal included, so the model can try another way */
const tools = (sandbox: Sandbox.Sandbox, context: Context.Context<never>) => {
  const run = (name: string, effect: Effect.Effect<string, Sandbox.SandboxError>, signal: AbortSignal | undefined) =>
    Effect.runPromiseWith(context)(
      effect.pipe(
        Effect.catchTag("SandboxError", (error) => Effect.succeed(`error: ${error.message}`)),
        Effect.withSpan(`Agent.tool ${name}`),
      ),
      { signal },
    )
  return {
    read_file: tool({
      description: "Read a file of the repository, with line numbers. Read a long file a range of lines at a time.",
      inputSchema: sdkSchema(ReadInput, false),
      execute: (input, { abortSignal }) => run("read_file", sandbox.read(input), abortSignal),
    }),
    search: tool({
      description: "Find the lines of the repository's files that contain some text: file:line: text.",
      inputSchema: sdkSchema(SearchInput, false),
      execute: (input, { abortSignal }) => run("search", sandbox.grep(input, abortSignal), abortSignal),
    }),
    list_files: tool({
      description: "List the repository's files, under a directory and/or matching a glob.",
      inputSchema: sdkSchema(ListInput, false),
      execute: (input, { abortSignal }) => run("list_files", sandbox.list(input, abortSignal), abortSignal),
    }),
  }
}

const OUTPUT_TOKENS: Record<Request["effort"], number> = { low: 16_000, medium: 32_000, high: 64_000 }

const reviewOutput = Output.object({ name: "review", description: "the review of the diff", schema: sdkSchema(ChunkReview, true) })

/** `connect`: where the api agent's models come from. tests hand in a mock */
export const make = Effect.fn("Agent.make")(function* (options: Options, connectModel: (model: string) => LanguageModel = connect(options.api)) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const env = agentEnv()
  const prices = options.prices ?? PRICES

  const fail = (agent: AgentKind) => (message: string) => new AgentError({ agent, message })

  /** a cli call that runs too long is stopped (its process with it) */
  const deadline = <A, R>(agent: AgentKind, effect: Effect.Effect<A, AgentError, R>) =>
    Effect.timeoutOrElse(effect, {
      duration: Duration.seconds(options.timeout),
      orElse: () => Effect.fail(fail(agent)(`timed out after ${options.timeout}s`)),
    })

  const usage = (model: string, spent: Omit<Usage, "calls" | "costUsd">, reported?: number): Usage => ({
    calls: 1,
    ...spent,
    costUsd: reported ?? estimate(model, spent, prices),
  })

  /** run to completion: stdout, stderr and the exit code, collected concurrently */
  const run = Effect.fn("Agent.run")(function* (agent: AgentKind, command: ChildProcess.Command) {
    const child = yield* spawner.spawn(command).pipe(Effect.mapError((e) => fail(agent)(`couldn't start ${agent}: ${e.message}`)))
    const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)
    const [stdout, stderr, code] = yield* Effect.all([text(child.stdout), text(child.stderr), child.exitCode], { concurrency: "unbounded" }).pipe(
      Effect.mapError((e) => fail(agent)(`${agent} crashed: ${String(e)}`)),
    )
    if (code !== 0) return yield* fail(agent)(`${agent} exited with ${code}: ${(stderr.trim() || stdout.trim()).slice(-2000)}`)
    return stdout
  })

  const inTempDir = <A, E, R>(agent: AgentKind, f: (dir: string) => Effect.Effect<A, E, R>) =>
    fs.makeTempDirectoryScoped({ prefix: "glance-" }).pipe(
      Effect.mapError((e) => new AgentError({ agent, message: `couldn't make a work directory: ${e.message}` })),
      Effect.flatMap(f),
      Effect.scoped,
    )

  const claude = (request: Request) =>
    inTempDir(request.agent, (dir) =>
      Effect.gen(function* () {
        const stdout = yield* run(
          "claude",
          ChildProcess.make(
            options.claudeBin,
            [
              "-p",
              "--output-format",
              "json",
              "--json-schema",
              reviewJsonSchema,
              ...(request.model ? ["--model", request.model] : []),
              "--effort",
              request.effort,
              "--system-prompt",
              request.system,
              // with the code: read and search it, nothing else. --restricted keeps the file tools
              // inside the checkout (symlinks included) and ignores any settings the repository ships
              ...(request.code ? ["--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--restricted"] : ["--tools", ""]),
              "--strict-mcp-config",
              "--safe-mode",
              "--no-session-persistence",
            ],
            { cwd: request.code ?? dir, env, stdin: Stream.encodeText(Stream.make(request.prompt)) },
          ),
        )
        const envelope = yield* decodeClaudeEnvelope(stdout).pipe(Effect.mapError(() => fail("claude")(`unexpected output: ${stdout.slice(0, 500)}`)))
        if (envelope.is_error || envelope.structured_output === undefined) return yield* fail("claude")(envelope.result ?? "no structured output")
        const review = yield* decodeReview(envelope.structured_output).pipe(Effect.mapError((e) => fail("claude")(`invalid review: ${e.message}`)))
        // claude code prices its own calls: its figure, over the table's
        const spent = Option.map(decodeClaudeUsage(envelope.usage), (u) =>
          usage(
            request.model,
            {
              inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
              cachedInputTokens: u.cache_read_input_tokens ?? 0,
              outputTokens: u.output_tokens,
            },
            Option.getOrUndefined(decodeCost(envelope.total_cost_usd)),
          ),
        )
        return { review, usage: Option.getOrUndefined(spent) }
      }),
    )

  const codex = (request: Request) =>
    inTempDir(request.agent, (dir) =>
      Effect.gen(function* () {
        const schemaPath = `${dir}/schema.json`
        const outputPath = `${dir}/out.json`
        const workDir = `${dir}/work`
        yield* Effect.all([fs.writeFileString(schemaPath, reviewJsonSchema), fs.makeDirectory(workDir)]).pipe(
          Effect.mapError((e) => fail("codex")(`couldn't prepare the work directory: ${e.message}`)),
        )
        const stdout = yield* run(
          "codex",
          ChildProcess.make(
            options.codexBin,
            [
              "exec",
              // its events on stdout: what each turn spent is among them
              "--json",
              "--ephemeral",
              "--skip-git-repo-check",
              "--ignore-user-config",
              "--ignore-rules",
              // Confine reads even in diff-only fallback: the default read-only sandbox can read home.
              "-C",
              request.code ?? workDir,
              "-c",
              'default_permissions="review"',
              "-c",
              'permissions.review.filesystem={":minimal"="read", ":workspace_roots"="read"}',
              // a repository's AGENTS.md is input from whoever wrote the pull request, not instructions
              "-c",
              "project_doc_max_bytes=0",
              ...(request.model ? ["-m", request.model] : []),
              "-c",
              `model_reasoning_effort="${request.effort}"`,
              "--output-schema",
              schemaPath,
              "-o",
              outputPath,
              "-",
            ],
            { cwd: dir, env, stdin: Stream.encodeText(Stream.make(`${request.system}\n\n---\n\n${request.prompt}`)) },
          ),
        )
        const output = yield* fs.readFileString(outputPath).pipe(Effect.mapError(() => fail("codex")("no output written")))
        const review = yield* decodeReviewJson(output).pipe(Effect.mapError((e) => fail("codex")(`invalid review: ${e.message}`)))
        const turns = stdout.split("\n").flatMap((line) => Option.toArray(decodeCodexTurn(line)))
        const spent =
          turns.length === 0
            ? undefined
            : usage(request.model, {
                inputTokens: turns.reduce((n, t) => n + t.usage.input_tokens, 0),
                cachedInputTokens: turns.reduce((n, t) => n + (t.usage.cached_input_tokens ?? 0), 0),
                outputTokens: turns.reduce((n, t) => n + t.usage.output_tokens, 0),
              })
        return { review, usage: spent }
      }),
    )

  /** why the api agent can't run, if it can't: a provider, a model and that provider's key */
  const apiProblem = (model: string) =>
    Option.match(options.api.provider, {
      onNone: () => "the api agent isn't set up: set GLANCE_API_PROVIDER",
      onSome: (provider) => (!model ? "set GLANCE_API_MODEL" : Option.isNone(options.api.key) ? `set ${KEY_VAR[provider]}` : undefined),
    })

  /** an error's own words, without the key in them should a provider ever echo it */
  const described = (error: unknown) => {
    const text =
      NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)
        ? `no valid review: ${error.message}`
        : APICallError.isInstance(error)
          ? `the provider answered ${error.statusCode ?? "nothing"}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error)
    const key = Option.match(options.api.key, { onNone: () => "", onSome: Redacted.value })
    return (key ? text.replaceAll(key, "[redacted]") : text).slice(0, 1000)
  }

  const api = Effect.fn("Agent.api")(function* (request: Request) {
    const model = request.model || options.api.model
    const problem = apiProblem(model)
    if (problem) return yield* fail("api")(problem)
    // diff only: no tools are offered at all
    const sandbox = request.code ? yield* Sandbox.make(request.code).pipe(Effect.mapError((e) => fail("api")(e.message))) : undefined
    const context = yield* Effect.context<never>()
    const maxSteps = Math.max(1, options.api.maxSteps)
    // every step counts, so what a failed or cut short call spent is known too
    const spent = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    const sofar = (): Usage | undefined => (spent.calls === 0 ? undefined : { ...spent, costUsd: estimate(model, spent, prices) })

    const result = yield* Effect.tryPromise({
      try: (signal) =>
        generateText({
          model: connectModel(model),
          system: request.system,
          prompt: request.prompt,
          output: reviewOutput,
          reasoning: request.effort,
          // openai counts reasoning against it too: a deeper review gets more room to think and still answer
          maxOutputTokens: OUTPUT_TOKENS[request.effort],
          maxRetries: 2,
          abortSignal: signal,
          ...(sandbox
            ? {
                tools: tools(sandbox, context),
                stopWhen: isStepCount(maxSteps),
                // the last step has no tools: whatever it has read by then, it answers
                prepareStep: ({ stepNumber }: { readonly stepNumber: number }) => (stepNumber >= maxSteps - 1 ? { activeTools: [] } : undefined),
              }
            : {}),
          onStepEnd: (step) => {
            const t = tokens(step.usage)
            spent.calls += 1
            spent.inputTokens += t.inputTokens
            spent.cachedInputTokens += t.cachedInputTokens
            spent.outputTokens += t.outputTokens
          },
        }),
      catch: (error) => new AgentError({ agent: "api", message: described(error), usage: sofar() }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(options.timeout),
        orElse: () => Effect.suspend(() => Effect.fail(new AgentError({ agent: "api", message: `timed out after ${options.timeout}s`, usage: sofar() }))),
      }),
    )
    const review = yield* Effect.try({
      try: () => result.output,
      catch: (error) => new AgentError({ agent: "api", message: described(error), usage: sofar() }),
    })
    yield* Effect.annotateCurrentSpan({ steps: result.steps.length, inputTokens: spent.inputTokens, outputTokens: spent.outputTokens })
    return { review, usage: sofar() }
  })

  // the api agent keeps its own time: what it spent before the deadline is counted
  const review = Effect.fn("Agent.review")(function* (request: Request): Effect.fn.Return<Answer, AgentError> {
    yield* Effect.annotateCurrentSpan({ agent: request.agent, model: request.model })
    if (request.agent === "api") return yield* api(request)
    return yield* deadline(request.agent, request.agent === "claude" ? claude(request) : codex(request))
  })

  // installed is not enough: a login expires quietly, and every review with it fails until it's renewed
  const check = Effect.fn("Agent.check")(function* (agent: AgentKind) {
    // a key is all it takes: checking it would cost a call
    if (agent === "api") {
      const problem = apiProblem(options.api.model)
      if (problem) return yield* fail("api")(problem)
      return `${Option.getOrElse(options.api.provider, () => "openai")} ${options.api.model}`
    }
    const bin = agent === "claude" ? options.claudeBin : options.codexBin
    const [version, status] = yield* Effect.all(
      [
        run(agent, ChildProcess.make(bin, ["--version"], { env })),
        run(agent, ChildProcess.make(bin, agent === "claude" ? ["auth", "status"] : ["login", "status"], { env })).pipe(
          Effect.mapError(() => fail(agent)(`${agent} isn't logged in`)),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(() => fail(agent)(`${agent} login check failed or timed out`)),
      Effect.scoped,
    )
    // claude answers in json, and exits 0 either way in some versions: its word over the exit code
    if (agent === "claude" && /"loggedIn":\s*false/.test(status)) return yield* fail(agent)("claude isn't logged in")
    return version.trim()
  })

  const models = Effect.fn("Agent.models")(function* (agent: AgentKind) {
    if (agent === "claude") return CLAUDE_MODELS
    if (agent === "api") {
      const extra = options.api.models.filter((m) => m !== options.api.model).map((id) => ({ id, label: id }))
      return [{ id: "", label: options.api.model ? `Default (${options.api.model})` : "Default" }, ...extra]
    }
    const stdout = yield* run("codex", ChildProcess.make(options.codexBin, ["debug", "models"], { env })).pipe(Effect.scoped)
    const catalog = yield* decodeCodexCatalog(stdout).pipe(Effect.mapError((e) => fail("codex")(`unexpected model catalog: ${e.message}`)))
    const listed = catalog.models
      .filter((m) => m.visibility === undefined || m.visibility === "list")
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => ({ id: m.slug, label: m.display_name ?? m.slug }))
    return [{ id: "", label: "Default" }, ...listed]
  })

  return Service.of({ review, check, models })
})

export const layer = (options: Options, connectModel?: (model: string) => LanguageModel) => Layer.effect(Service, make(options, connectModel))

export * as Agent from "./agent.ts"
