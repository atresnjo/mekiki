import { Effect, Option, Schema } from "effect"

export const AgentKind = Schema.Literals(["claude", "codex"])
export type AgentKind = typeof AgentKind.Type

/** how hard the agent thinks: the one knob between a quick pass and a thorough one */
export const Depth = Schema.Literals(["light", "medium", "high"])
export type Depth = typeof Depth.Type

/** the reasoning effort each depth runs at, in both CLIs */
export const EFFORT: Record<Depth, "low" | "medium" | "high"> = { light: "low", medium: "medium", high: "high" }

/** a depth named in a label or comment: `glance:high`, `glance-light`, `/glance medium` */
export const depthIn = (text: string): Depth | undefined => {
  const m = text.match(/(?:^|[\s/@])glance(?:[:/ -]|\s+)(light|medium|high)\b/i)
  return m?.[1] ? Option.getOrUndefined(Schema.decodeUnknownOption(Depth)(m[1].toLowerCase())) : undefined
}

export const Severity = Schema.Literals(["critical", "high", "medium", "low"])
export type Severity = typeof Severity.Type

export const Category = Schema.Literals(["bug", "security", "performance", "reliability", "maintainability"])
export type Category = typeof Category.Type

/** one review comment, as the model is asked to produce it */
export const Finding = Schema.Struct({
  path: Schema.String,
  line: Schema.Int,
  severity: Severity,
  category: Category,
  title: Schema.String,
  body: Schema.String,
  /** replacement for exactly `line`, or null */
  suggestion: Schema.NullOr(Schema.String),
  confidence: Schema.Finite,
})
export interface Finding extends Schema.Schema.Type<typeof Finding> {}

/** what one agent call returns: its JSON schema is handed to the CLI */
export const ChunkReview = Schema.Struct({
  summary: Schema.String,
  findings: Schema.Array(Finding),
})
export interface ChunkReview extends Schema.Schema.Type<typeof ChunkReview> {}

/** when a pull request opens: review it right away, or post the depth checkboxes and wait for a tick */
export const Mode = Schema.Literals(["ask", "auto"])
export type Mode = typeof Mode.Type

export const Settings = Schema.Struct({
  agent: AgentKind,
  /** empty: the CLI's own default */
  model: Schema.String,
  depth: Depth,
  mode: Mode,
  postComments: Schema.Boolean,
  maxFindings: Schema.Finite,
  minConfidence: Schema.Finite,
  /**
   * the team's review rules, in plain language. they come from here and nowhere else: the repository's
   * own CLAUDE.md or AGENTS.md is ignored, since a pull request can edit them
   */
  rules: Schema.String,
  /** github logins whose pull requests are never reviewed on their own, and get no comment */
  blockedAuthors: Schema.Array(Schema.String),
  /** not empty: in auto mode only these authors' pull requests are reviewed right away, the rest get the checkboxes */
  allowedAuthors: Schema.Array(Schema.String),
  /** globs of files never reviewed, on top of lockfiles and generated files */
  exclude: Schema.Array(Schema.String),
})
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

/** one repository's own settings, on top of the dashboard's: a null mode or depth is the global one, the lists add to the global lists */
export const RepoSettings = Schema.Struct({
  /** owner/repo, lowercase */
  repo: Schema.String,
  mode: Schema.NullOr(Mode),
  depth: Schema.NullOr(Depth),
  rules: Schema.String,
  blockedAuthors: Schema.Array(Schema.String),
  allowedAuthors: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String),
})
export interface RepoSettings extends Schema.Schema.Type<typeof RepoSettings> {}

/** a repository with nothing of its own yet */
export const repoSettings = (repo: string): RepoSettings => ({
  repo: repo.toLowerCase(),
  mode: null,
  depth: null,
  rules: "",
  blockedAuthors: [],
  allowedAuthors: [],
  exclude: [],
})

/** rules longer than this aren't saved: every character is sent with every chunk */
export const RULES_MAX = 4000

/** entries past this in an author or exclude list aren't saved */
export const LIST_MAX = 200

const REPO = /^[\w.-]+\/[\w.-]+$/
/** a github login: letters, digits and dashes, and an app's `[bot]` */
const LOGIN = /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\[bot\])?$/i

export const isRepo = (text: string) => REPO.test(text)
/** `owner/repo` from what someone typed or pasted: itself, or a github url to the repository or anything in it */
export const repoIn = (text: string) => {
  const trimmed = text.trim().replace(/\.git$/, "")
  const path = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+\/[^/?#]+)/i)?.[1] ?? trimmed
  return path.toLowerCase()
}
export const isLogin = (text: string) => LOGIN.test(text)

const union = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => [...new Set([...a, ...b])]

/** what a review of this repository runs with: the global settings, with the repository's on top */
export const effective = (global: Settings, repo: RepoSettings | undefined): Settings =>
  repo === undefined
    ? global
    : {
        ...global,
        mode: repo.mode ?? global.mode,
        depth: repo.depth ?? global.depth,
        rules: [global.rules.trim(), repo.rules.trim()].filter(Boolean).join("\n\n"),
        blockedAuthors: union(global.blockedAuthors, repo.blockedAuthors),
        allowedAuthors: union(global.allowedAuthors, repo.allowedAuthors),
        exclude: union(global.exclude, repo.exclude),
      }

/** logins compare without case, as on github */
export const listsAuthor = (logins: ReadonlyArray<string>, login: string) => logins.some((l) => l.toLowerCase() === login.toLowerCase())

/** a list as typed: trimmed, empty entries and repeats dropped */
export const cleanList = (entries: ReadonlyArray<string>) => [...new Set(entries.map((e) => e.trim()).filter(Boolean))]

/** what's wrong with these rules and lists, if anything: they're saved only when nothing is */
export const settingsProblem = (s: Pick<Settings, "rules" | "blockedAuthors" | "allowedAuthors" | "exclude">): string | undefined => {
  if (s.rules.length > RULES_MAX) return `rules are ${s.rules.length} characters; at most ${RULES_MAX}`
  for (const [name, list] of [
    ["blocked authors", s.blockedAuthors],
    ["allowed authors", s.allowedAuthors],
    ["exclude patterns", s.exclude],
  ] as const)
    if (list.length > LIST_MAX) return `${list.length} ${name}; at most ${LIST_MAX}`
  const login = [...s.blockedAuthors, ...s.allowedAuthors].find((l) => !isLogin(l))
  if (login !== undefined) return `"${login}" isn't a github login`
  const glob = s.exclude.find((g) => g.length > 200)
  if (glob !== undefined) return `exclude pattern "${glob.slice(0, 40)}…" is too long`
  return undefined
}

export const ReviewStatus = Schema.Literals(["running", "done", "failed", "cancelled", "skipped"])
export type ReviewStatus = typeof ReviewStatus.Type

export const Step = Schema.Struct({ name: Schema.String, ms: Schema.Finite })
export interface Step extends Schema.Schema.Type<typeof Step> {}

export const Review = Schema.Struct({
  id: Schema.Finite,
  repo: Schema.String,
  number: Schema.Finite,
  title: Schema.String,
  url: Schema.String,
  headSha: Schema.String,
  agent: AgentKind,
  model: Schema.String,
  depth: Depth,
  status: ReviewStatus,
  trigger: Schema.String,
  /** reviewed, but nothing posted */
  dryRun: Schema.Boolean,
  incremental: Schema.Boolean,
  posted: Schema.Boolean,
  files: Schema.Finite,
  skippedFiles: Schema.Finite,
  chunks: Schema.Finite,
  startedAt: Schema.Finite,
  durationMs: Schema.NullOr(Schema.Finite),
  summary: Schema.String,
  findings: Schema.Array(Finding),
  /**
   * the files of the chunks whose agent failed: a review with any is partial. it says so on github,
   * and the next one doesn't start from it. reviews saved before this was kept have none
   */
  unreviewed: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  steps: Schema.Array(Step),
  error: Schema.NullOr(Schema.String),
})
export interface Review extends Schema.Schema.Type<typeof Review> {}

/** owner/repo#number */
export interface PrRef {
  readonly owner: string
  readonly repo: string
  readonly number: number
}

export const prKey = (pr: PrRef) => `${pr.owner}/${pr.repo}#${pr.number}`

export const parsePrUrl = (input: string): PrRef | undefined => {
  const m = input.trim().match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/) ?? input.trim().match(/^([^/\s]+)\/([^/\s#]+)#(\d+)$/)
  return m?.[1] && m[2] && m[3] ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined
}

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  agent: AgentKind,
  message: Schema.String,
}) {}

export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  operation: Schema.String,
  status: Schema.optional(Schema.Finite),
  message: Schema.String,
}) {}

/** finished, but some of it couldn't be reviewed */
export const partial = (review: Pick<Review, "status" | "unreviewed">) => review.status === "done" && review.unreviewed.length > 0
