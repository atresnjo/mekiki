import { resolve } from "node:path"
import { Config, Option, Redacted, Schema } from "effect"
import { PROVIDERS } from "./agent.ts"
import type { Settings } from "./domain.ts"
import { PRICES, Prices } from "./prices.ts"

/** a comma separated list, empty entries dropped */
const list = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )

/** everything read from the environment, once, at startup */
export const AppConfig = Config.all({
  port: Config.Port("PORT").pipe(Config.withDefault(7420)),
  host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  /** postgres. the default is the one the readme starts for development */
  databaseUrl: Config.Redacted("DATABASE_URL").pipe(Config.withDefault(Redacted.make("postgres://mekiki:mekiki@127.0.0.1:5432/mekiki"))),
  /**
   * production refuses to start without sign-in. it's production when MEKIKI_ENV says so (the docker
   * image does) or when mekiki listens beyond this machine: see requiresSignIn
   */
  env: Config.Literals(["development", "production"], "MEKIKI_ENV").pipe(Config.withDefault("development" as const)),
  /** signing in to the dashboard: better auth, with github and/or the company's sso, and who may come in */
  auth: Config.all({
    /** where people open mekiki: oauth callbacks come back here, and only this origin may sign in */
    url: Config.String("BETTER_AUTH_URL").pipe(Config.withDefault("http://localhost:7421")),
    /** signs sessions and encrypts the oauth tokens kept: 32 characters at least (`openssl rand -base64 32`) */
    secret: Config.option(Config.Redacted("BETTER_AUTH_SECRET")),
    sessionDays: Config.Int("MEKIKI_SESSION_DAYS").pipe(Config.withDefault(7)),
    /** behind a reverse proxy (the docker setup): the client's address is X-Forwarded-For's, for sign-in limits */
    trustProxy: Config.Boolean("MEKIKI_TRUST_PROXY").pipe(Config.withDefault(false)),
    /** sign in with github: an oauth app's (or the github app's) client id and secret */
    github: Config.all({
      clientId: Config.option(Config.String("GITHUB_CLIENT_ID")),
      clientSecret: Config.option(Config.Redacted("GITHUB_CLIENT_SECRET")),
    }),
    /** sign in with the company's identity provider: oidc (issuer, client id and secret) or saml (the idp's metadata) */
    sso: Config.all({
      /** what the sign-in button says: "Continue with Okta" */
      name: Config.String("MEKIKI_SSO_NAME").pipe(Config.withDefault("SSO")),
      /** the company's email domain: whoever the provider signs in with an address there is let in */
      domain: Config.option(Config.String("MEKIKI_SSO_DOMAIN")),
      issuer: Config.option(Config.String("MEKIKI_SSO_ISSUER")),
      clientId: Config.option(Config.String("MEKIKI_SSO_CLIENT_ID")),
      clientSecret: Config.option(Config.Redacted("MEKIKI_SSO_CLIENT_SECRET")),
      /** default: the issuer's /.well-known/openid-configuration */
      discoveryUrl: Config.option(Config.String("MEKIKI_SSO_DISCOVERY_URL")),
      samlMetadataFile: Config.option(Config.String("MEKIKI_SSO_SAML_METADATA_FILE")),
    }),
    /** who may sign in: addresses (alice@acme.com) and whole domains (@acme.com). github's must be verified */
    allowedEmails: list("MEKIKI_ALLOWED_EMAILS"),
    /** members of these github organizations may sign in with github */
    allowedGithubOrgs: list("MEKIKI_ALLOWED_GITHUB_ORGS"),
  }),
  github: Config.all({
    apiUrl: Config.String("GITHUB_API_URL").pipe(Config.withDefault("https://api.github.com")),
    token: Config.option(Config.Redacted("GITHUB_TOKEN")),
    /** a github app instead of a token: its own rate limits, and comments under its name */
    app: Config.all({
      id: Config.option(Config.String("GITHUB_APP_ID")),
      /** the pem, or a file holding it */
      privateKey: Config.option(Config.Redacted("GITHUB_APP_PRIVATE_KEY")),
      privateKeyFile: Config.option(Config.String("GITHUB_APP_PRIVATE_KEY_FILE")),
    }),
    webhookSecret: Config.option(Config.Redacted("GITHUB_WEBHOOK_SECRET")),
    /** bigger webhook deliveries are refused (github's own limit is 25 MB) */
    maxWebhookBytes: Config.Int("GITHUB_WEBHOOK_MAX_BYTES").pipe(Config.withDefault(5 * 1024 * 1024)),
    /** after a review, resolve mekiki's own threads whose code changed and whose problem it didn't find again */
    resolveFixed: Config.Boolean("MEKIKI_RESOLVE_FIXED").pipe(Config.withDefault(true)),
  }),
  /** who may start a review from github (a comment, a ticked box, a label), and how often */
  triggers: Config.all({
    /** the least repository permission it takes: read | triage | write | maintain | admin */
    permission: Config.Literals(["read", "triage", "write", "maintain", "admin"], "MEKIKI_TRIGGER_PERMISSION").pipe(Config.withDefault("write" as const)),
    perUserPerHour: Config.Int("MEKIKI_REVIEWS_PER_USER_HOUR").pipe(Config.withDefault(30)),
    perPullRequestPerHour: Config.Int("MEKIKI_REVIEWS_PER_PR_HOUR").pipe(Config.withDefault(10)),
  }),
  /** the code each review reads: one directory per commit */
  checkouts: Config.all({
    // absolute: an agent runs in a directory of its own and is handed the checkout's path
    dir: Config.String("MEKIKI_CHECKOUTS").pipe(
      Config.withDefault(".data/checkouts"),
      Config.map((dir) => resolve(dir)),
    ),
    /** a repository bigger than this isn't downloaded, by git or as a tarball */
    maxMegabytes: Config.Int("MAX_REPO_MB").pipe(Config.withDefault(500)),
    keep: Config.Int("KEEP_CHECKOUTS").pipe(Config.withDefault(30)),
    /** everything under MEKIKI_CHECKOUTS together: the least recently used goes first when it's over */
    diskBudgetMegabytes: Config.Int("MEKIKI_DISK_BUDGET_MB").pipe(Config.withDefault(20 * 1024)),
    /** one download (git or the tarball) gives up after this */
    timeout: Config.Int("CHECKOUT_TIMEOUT_SECONDS").pipe(Config.withDefault(300)),
  }),
  agent: Config.all({
    /** the claude and codex clis: off, mekiki reviews with the api agent alone and never starts either (the docker image) */
    clis: Config.Boolean("MEKIKI_CLI_AGENTS").pipe(Config.withDefault(true)),
    claudeBin: Config.String("CLAUDE_BIN").pipe(Config.withDefault("claude")),
    codexBin: Config.String("CODEX_BIN").pipe(Config.withDefault("codex")),
    // reading the code takes the agent a few turns: more room than a single answer
    timeout: Config.Int("AGENT_TIMEOUT_SECONDS").pipe(Config.withDefault(600)),
    /**
     * the api agent: a model on an API key, billed per token, for teams and companies (the CLIs'
     * subscription logins are for one person's own use). the key is the provider's usual variable,
     * read here and handed to nobody else: the CLIs' environment never has it
     */
    api: Config.all({
      provider: Config.option(Config.Literals(PROVIDERS, "MEKIKI_API_PROVIDER")),
      model: Config.String("MEKIKI_API_MODEL").pipe(Config.withDefault("")),
      /** more models the dashboard offers: gpt-6-luna,gpt-6-sol */
      models: list("MEKIKI_API_MODELS"),
      /** an openai-compatible gateway: openrouter, litellm, azure */
      baseUrl: Config.option(Config.String("MEKIKI_API_BASE_URL")),
      maxSteps: Config.Int("MEKIKI_API_MAX_STEPS").pipe(Config.withDefault(30)),
      keys: Config.all({
        openai: Config.option(Config.Redacted("OPENAI_API_KEY")),
        anthropic: Config.option(Config.Redacted("ANTHROPIC_API_KEY")),
        google: Config.option(Config.Redacted("GOOGLE_GENERATIVE_AI_API_KEY")),
      }),
    }).pipe(Config.map(({ keys, ...api }) => ({ ...api, key: Option.flatMap(api.provider, (provider) => keys[provider]) }))),
    /** dollars per million tokens, on top of prices.ts: `{"my-model": {"input": 1, "cachedInput": 0.1, "output": 5}}` */
    prices: Config.schema(Schema.fromJsonString(Prices), "MEKIKI_PRICES").pipe(
      Config.withDefault({}),
      Config.map((extra): Prices => ({ ...PRICES, ...extra })),
    ),
  }),
  limits: Config.all({
    maxDiffChars: Config.Int("MAX_DIFF_CHARS").pipe(Config.withDefault(400_000)),
    maxFileChars: Config.Int("MAX_FILE_CHARS").pipe(Config.withDefault(80_000)),
    chunkChars: Config.Int("CHUNK_CHARS").pipe(Config.withDefault(150_000)),
    concurrency: Config.Int("AGENT_CONCURRENCY").pipe(Config.withDefault(4)),
    /** reviews running or waiting for an agent at once: past it, a review is turned away (and says so) */
    maxQueued: Config.Int("MAX_QUEUED_REVIEWS").pipe(Config.withDefault(20)),
  }),
  observability: Config.all({
    /** json in production (one object per line, for a log collector), pretty while developing */
    logFormat: Config.Literals(["pretty", "json"], "MEKIKI_LOG_FORMAT").pipe(Config.withDefault("pretty" as const)),
    logLevel: Config.LogLevel("MEKIKI_LOG_LEVEL").pipe(Config.withDefault("Info" as const)),
    /** an otlp collector's base url: traces and logs go there too */
    otlpUrl: Config.option(Config.String("MEKIKI_OTLP_URL")),
  }),
  /** settings until they're changed in the dashboard */
  defaults: Config.all({
    agent: Config.Literals(["claude", "codex", "api"], "MEKIKI_AGENT").pipe(Config.withDefault("claude" as const)),
    model: Config.String("MEKIKI_MODEL").pipe(Config.withDefault("")),
    depth: Config.Literals(["light", "medium", "high"], "MEKIKI_DEPTH").pipe(Config.withDefault("light" as const)),
    mode: Config.Literals(["ask", "auto"], "MEKIKI_MODE").pipe(Config.withDefault("ask" as const)),
    postComments: Config.Boolean("MEKIKI_POST_COMMENTS").pipe(Config.withDefault(true)),
    maxFindings: Config.Int("MEKIKI_MAX_FINDINGS").pipe(Config.withDefault(10)),
    minConfidence: Config.Finite("MEKIKI_MIN_CONFIDENCE").pipe(Config.withDefault(0.6)),
    /** the team's rules are written in the dashboard: several paragraphs don't fit an env var */
    rules: Config.succeed(""),
    /** github logins never reviewed on their own: dependabot[bot],renovate[bot] */
    blockedAuthors: list("MEKIKI_BLOCKED_AUTHORS"),
    allowedAuthors: Config.succeed<ReadonlyArray<string>>([]),
    /** globs never reviewed, on top of lockfiles and generated files: docs/**,*.snap */
    exclude: list("MEKIKI_EXCLUDE"),
  }) satisfies Config.Config<Settings>,
})

export type AppConfig = Config.Success<typeof AppConfig>
