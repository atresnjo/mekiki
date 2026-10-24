// the reviewers: `claude -p` and `codex exec`, each running on its own subscription login.
// one call is one short-lived process with no tools, no MCP servers, no project context and our
// own short system prompt: a single structured answer, nothing to explore, so it comes back fast
import { Context, Duration, Effect, FileSystem, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { AgentError, type AgentKind, ChunkReview } from "./domain.ts"

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

export interface Interface {
  readonly review: (request: Request) => Effect.Effect<ChunkReview, AgentError>
  /** the CLI's version, or why it can't run */
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

export const Options = Schema.Struct({
  claudeBin: Schema.String,
  codexBin: Schema.String,
  timeout: Schema.Finite,
})
export interface Options extends Schema.Schema.Type<typeof Options> {}

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

/** what both CLIs accept as an output schema: closed objects, every key required */
const jsonSchema = (() => {
  const close = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(close)
    if (node === null || typeof node !== "object") return node
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) out[key] = close(value)
    if (out.type === "object") out.additionalProperties = false
    return out
  }
  return JSON.stringify(close(Schema.toJsonSchemaDocument(ChunkReview).schema))
})()

const ClaudeEnvelope = Schema.Struct({
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.String),
  structured_output: Schema.optional(Schema.Unknown),
})

const decodeClaudeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeEnvelope))
const decodeReview = Schema.decodeUnknownEffect(ChunkReview)
const decodeReviewJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ChunkReview))

export const make = Effect.fn("Agent.make")(function* (options: Options) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const env = agentEnv()

  const fail = (agent: AgentKind) => (message: string) => new AgentError({ agent, message })

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
              jsonSchema,
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
        return yield* decodeReview(envelope.structured_output).pipe(Effect.mapError((e) => fail("claude")(`invalid review: ${e.message}`)))
      }),
    )

  const codex = (request: Request) =>
    inTempDir(request.agent, (dir) =>
      Effect.gen(function* () {
        const schemaPath = `${dir}/schema.json`
        const outputPath = `${dir}/out.json`
        const workDir = `${dir}/work`
        yield* Effect.all([fs.writeFileString(schemaPath, jsonSchema), fs.makeDirectory(workDir)]).pipe(
          Effect.mapError((e) => fail("codex")(`couldn't prepare the work directory: ${e.message}`)),
        )
        yield* run(
          "codex",
          ChildProcess.make(
            options.codexBin,
            [
              "exec",
              "--ephemeral",
              "--skip-git-repo-check",
              "--ignore-user-config",
              "--ignore-rules",
              // read-only everywhere is codex's default sandbox; with the code, a profile that may read
              // only the checkout (plus the system files a shell needs): not your home directory
              ...(request.code
                ? [
                    "-C",
                    request.code,
                    "-c",
                    'default_permissions="review"',
                    "-c",
                    'permissions.review.filesystem={":minimal"="read", ":workspace_roots"="read"}',
                  ]
                : ["-s", "read-only", "-C", workDir]),
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
        return yield* decodeReviewJson(output).pipe(Effect.mapError((e) => fail("codex")(`invalid review: ${e.message}`)))
      }),
    )

  const review = Effect.fn("Agent.review")(
    function* (request: Request) {
      yield* Effect.annotateCurrentSpan({ agent: request.agent, model: request.model })
      return yield* request.agent === "claude" ? claude(request) : codex(request)
    },
    (effect, request) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(options.timeout),
          orElse: () => Effect.fail(new AgentError({ agent: request.agent, message: `timed out after ${options.timeout}s` })),
        }),
      ),
  )

  // installed is not enough: a login expires quietly, and every review with it fails until it's renewed
  const check = Effect.fn("Agent.check")(function* (agent: AgentKind) {
    const bin = agent === "claude" ? options.claudeBin : options.codexBin
    const [version, status] = yield* Effect.all(
      [
        run(agent, ChildProcess.make(bin, ["--version"], { env })),
        run(agent, ChildProcess.make(bin, agent === "claude" ? ["auth", "status"] : ["login", "status"], { env })).pipe(
          Effect.mapError(() => fail(agent)(`${agent} isn't logged in`)),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.scoped)
    // claude answers in json, and exits 0 either way in some versions: its word over the exit code
    if (agent === "claude" && /"loggedIn":\s*false/.test(status)) return yield* fail(agent)("claude isn't logged in")
    return version.trim()
  })

  const models = Effect.fn("Agent.models")(function* (agent: AgentKind) {
    if (agent === "claude") return CLAUDE_MODELS
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

export const layer = (options: Options) => Layer.effect(Service, make(options))

export * as Agent from "./agent.ts"
