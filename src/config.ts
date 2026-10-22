import { Config, Option } from "effect"
import type { Settings } from "./domain.ts"

/** everything read from the environment, once, at startup */
export const AppConfig = Config.all({
  port: Config.Port("PORT").pipe(Config.withDefault(7420)),
  host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  dbPath: Config.String("GLANCE_DB").pipe(Config.withDefault(".data/glance.db")),
  /**
   * the access token the dashboard is signed in with. GLANCE_TOKEN_FILE is read again every
   * half minute, so the token can be rotated without a restart; rotating it signs everyone out
   */
  auth: Config.all({
    token: Config.option(Config.Redacted("GLANCE_TOKEN")),
    tokenFile: Config.option(Config.String("GLANCE_TOKEN_FILE")),
    sessionDays: Config.Int("GLANCE_SESSION_DAYS").pipe(Config.withDefault(30)),
    /** behind a reverse proxy (the docker setup): the client's address is X-Forwarded-For's first entry */
    trustProxy: Config.Boolean("GLANCE_TRUST_PROXY").pipe(Config.withDefault(false)),
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
  /** the code each review reads: one directory per commit */
  checkouts: Config.all({
    dir: Config.String("GLANCE_CHECKOUTS").pipe(Config.withDefault(".data/checkouts")),
    maxMegabytes: Config.Int("MAX_REPO_MB").pipe(Config.withDefault(500)),
    keep: Config.Int("KEEP_CHECKOUTS").pipe(Config.withDefault(30)),
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
  }),
  /** snapshots of the database, beside it unless told otherwise. copy them off the machine too */
  backups: Config.all({
    dir: Config.String("GLANCE_BACKUPS").pipe(Config.withDefault(".data/backups")),
    /** 0: no backups */
    everyHours: Config.Int("GLANCE_BACKUP_HOURS").pipe(Config.withDefault(24)),
    keep: Config.Int("GLANCE_BACKUP_KEEP").pipe(Config.withDefault(7)),
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

/** a token is set, one way or the other: the dashboard needs signing in */
export const authEnabled = (config: AppConfig) => Option.isSome(config.auth.token) || Option.isSome(config.auth.tokenFile)
