import { Config, Redacted } from "effect"
import type { Settings } from "./domain.ts"

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
  databaseUrl: Config.Redacted("DATABASE_URL").pipe(Config.withDefault(Redacted.make("postgres://glance:glance@127.0.0.1:5432/glance"))),
  /**
   * production refuses to start without sign-in. it's production when GLANCE_ENV says so (the docker
   * image does) or when glance listens beyond this machine: see requiresSignIn
   */
  env: Config.Literals(["development", "production"], "GLANCE_ENV").pipe(Config.withDefault("development" as const)),
  /** signing in to the dashboard: better auth, with github and/or the company's sso, and who may come in */
  auth: Config.all({
    /** where people open glance: oauth callbacks come back here, and only this origin may sign in */
    url: Config.String("BETTER_AUTH_URL").pipe(Config.withDefault("http://localhost:7421")),
    /** signs sessions and encrypts the oauth tokens kept: 32 characters at least (`openssl rand -base64 32`) */
    secret: Config.option(Config.Redacted("BETTER_AUTH_SECRET")),
    sessionDays: Config.Int("GLANCE_SESSION_DAYS").pipe(Config.withDefault(7)),
    /** behind a reverse proxy (the docker setup): the client's address is X-Forwarded-For's, for sign-in limits */
    trustProxy: Config.Boolean("GLANCE_TRUST_PROXY").pipe(Config.withDefault(false)),
    /** sign in with github: an oauth app's (or the github app's) client id and secret */
    github: Config.all({
      clientId: Config.option(Config.String("GITHUB_CLIENT_ID")),
      clientSecret: Config.option(Config.Redacted("GITHUB_CLIENT_SECRET")),
    }),
    /** sign in with the company's identity provider: oidc (issuer, client id and secret) or saml (the idp's metadata) */
    sso: Config.all({
      /** what the sign-in button says: "Continue with Okta" */
      name: Config.String("GLANCE_SSO_NAME").pipe(Config.withDefault("SSO")),
      /** the company's email domain: whoever the provider signs in with an address there is let in */
      domain: Config.option(Config.String("GLANCE_SSO_DOMAIN")),
      issuer: Config.option(Config.String("GLANCE_SSO_ISSUER")),
      clientId: Config.option(Config.String("GLANCE_SSO_CLIENT_ID")),
      clientSecret: Config.option(Config.Redacted("GLANCE_SSO_CLIENT_SECRET")),
      /** default: the issuer's /.well-known/openid-configuration */
      discoveryUrl: Config.option(Config.String("GLANCE_SSO_DISCOVERY_URL")),
      samlMetadataFile: Config.option(Config.String("GLANCE_SSO_SAML_METADATA_FILE")),
    }),
    /** who may sign in: addresses (alice@acme.com) and whole domains (@acme.com). github's must be verified */
    allowedEmails: list("GLANCE_ALLOWED_EMAILS"),
    /** members of these github organizations may sign in with github */
    allowedGithubOrgs: list("GLANCE_ALLOWED_GITHUB_ORGS"),
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
  }),
  /** who may start a review from github (a comment, a ticked box, a label), and how often */
  triggers: Config.all({
    /** the least repository permission it takes: read | triage | write | maintain | admin */
    permission: Config.Literals(["read", "triage", "write", "maintain", "admin"], "GLANCE_TRIGGER_PERMISSION").pipe(Config.withDefault("write" as const)),
    perUserPerHour: Config.Int("GLANCE_REVIEWS_PER_USER_HOUR").pipe(Config.withDefault(30)),
    perPullRequestPerHour: Config.Int("GLANCE_REVIEWS_PER_PR_HOUR").pipe(Config.withDefault(10)),
  }),
  /** the code each review reads: one directory per commit */
  checkouts: Config.all({
    dir: Config.String("GLANCE_CHECKOUTS").pipe(Config.withDefault(".data/checkouts")),
    /** a repository bigger than this isn't downloaded, by git or as a tarball */
    maxMegabytes: Config.Int("MAX_REPO_MB").pipe(Config.withDefault(500)),
    keep: Config.Int("KEEP_CHECKOUTS").pipe(Config.withDefault(30)),
    /** everything under GLANCE_CHECKOUTS together: the least recently used goes first when it's over */
    diskBudgetMegabytes: Config.Int("GLANCE_DISK_BUDGET_MB").pipe(Config.withDefault(20 * 1024)),
    /** one download (git or the tarball) gives up after this */
    timeout: Config.Int("CHECKOUT_TIMEOUT_SECONDS").pipe(Config.withDefault(300)),
  }),
  agent: Config.all({
    claudeBin: Config.String("CLAUDE_BIN").pipe(Config.withDefault("claude")),
    codexBin: Config.String("CODEX_BIN").pipe(Config.withDefault("codex")),
    // reading the code takes the agent a few turns: more room than a single answer
    timeout: Config.Int("AGENT_TIMEOUT_SECONDS").pipe(Config.withDefault(600)),
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
    logFormat: Config.Literals(["pretty", "json"], "GLANCE_LOG_FORMAT").pipe(Config.withDefault("pretty" as const)),
    logLevel: Config.LogLevel("GLANCE_LOG_LEVEL").pipe(Config.withDefault("Info" as const)),
    /** an otlp collector's base url: traces and logs go there too */
    otlpUrl: Config.option(Config.String("GLANCE_OTLP_URL")),
  }),
  /** settings until they're changed in the dashboard */
  defaults: Config.all({
    agent: Config.Literals(["claude", "codex"], "GLANCE_AGENT").pipe(Config.withDefault("claude" as const)),
    model: Config.String("GLANCE_MODEL").pipe(Config.withDefault("")),
    depth: Config.Literals(["light", "medium", "high"], "GLANCE_DEPTH").pipe(Config.withDefault("light" as const)),
    mode: Config.Literals(["ask", "auto"], "GLANCE_MODE").pipe(Config.withDefault("ask" as const)),
    postComments: Config.Boolean("GLANCE_POST_COMMENTS").pipe(Config.withDefault(true)),
    maxFindings: Config.Int("GLANCE_MAX_FINDINGS").pipe(Config.withDefault(10)),
    minConfidence: Config.Finite("GLANCE_MIN_CONFIDENCE").pipe(Config.withDefault(0.6)),
  }) satisfies Config.Config<Settings>,
})

export type AppConfig = Config.Success<typeof AppConfig>
